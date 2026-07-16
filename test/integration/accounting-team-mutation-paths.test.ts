import { describe, expect, it, vi } from 'vitest';
import { AccountingMutationService, ChartOfAccountsProposalSchemaV1 } from '@plus-one/accounting';
import { CheckedMutationWorkCellCoordinator } from '@plus-one/mutations';
import {
  MutationReceiptSchemaV1,
  MakerArtifactSchemaV1,
  ReadbackResultSchemaV1,
  type CheckedCommandV1,
  type JsonValue,
  type MutationReceiptV1,
  type ReadbackResultV1,
} from '@plus-one/contracts';
import { hashArtifact } from '@plus-one/runtime';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const bookId = 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const taskId = 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const commandId = 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const idempotencyKey = 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const confirmationId = 'confirm_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const now = '2026-06-23T10:00:00.000Z';

describe('accounting team mutation paths', () => {
  it.each([
    ['transaction-capture'],
    ['journal'],
  ] as const)('routes verified %s output into the journal mutation command adapter', async (workCellId) => {
    const { service, mutationExecutor, runtime } = setup(journalChecked(workCellId));
    const result = await service.execute({
      workCellId,
      workCellInput: {} as never,
      commandId,
      idempotencyKey,
    });

    expect(mutationExecutor.execute).toHaveBeenCalledWith(expect.objectContaining({
      commandType: 'apply_accounting_journal_mutation',
      checkedProposalId: result.makerArtifacts[0]!.artifactId,
      payloadSchema: { schemaName: 'accounting-work-result', schemaVersion: 1 },
    }));
    expect(runtime.complete).toHaveBeenCalledWith({ householdId, taskId, status: 'verified' });
  });

  it('routes verified chart output only when an exact confirmation is supplied', async () => {
    const { service, mutationExecutor } = setup(chartChecked());

    await expect(service.execute({
      workCellId: 'chart-of-accounts',
      workCellInput: {} as never,
      commandId,
      idempotencyKey,
    })).rejects.toMatchObject({ code: 'chart_confirmation_required' });

    await expect(service.execute({
      workCellId: 'chart-of-accounts',
      workCellInput: {} as never,
      commandId,
      idempotencyKey,
      confirmationId,
    })).resolves.toMatchObject({ status: 'verified', completionState: 'terminal' });
    expect(mutationExecutor.execute).toHaveBeenCalledWith(expect.objectContaining({
      commandType: 'apply_chart_of_accounts_change',
      confirmationId,
      payloadSchema: { schemaName: 'chart-of-accounts-proposal', schemaVersion: 1 },
    }));
  });

  it('does not execute mutation commands for clarification outputs or non-verified work cells', async () => {
    const clarification = setup(journalChecked('transaction-capture', {
      schemaName: 'accounting-clarification',
      schemaVersion: 1,
      missingFields: ['payment_account'],
      questions: ['Which account paid for this?'],
      reason: 'Payment account is unresolved.',
    }));
    await expect(clarification.service.execute({
      workCellId: 'transaction-capture',
      workCellInput: {} as never,
      commandId,
      idempotencyKey,
    })).rejects.toMatchObject({ code: 'accounting_clarification_not_executable' });
    expect(clarification.mutationExecutor.execute).not.toHaveBeenCalled();

    const chartClarification = setup(chartClarificationChecked());
    await expect(chartClarification.service.execute({
      workCellId: 'chart-of-accounts',
      workCellInput: {} as never,
      commandId,
      idempotencyKey,
      confirmationId,
    })).rejects.toMatchObject({ code: 'checked_mutation_result_invalid' });
    expect(chartClarification.mutationExecutor.execute).not.toHaveBeenCalled();

    const failed = setup({ ...journalChecked('journal'), status: 'failed' });
    await expect(failed.service.execute({
      workCellId: 'journal',
      workCellInput: {} as never,
      commandId,
      idempotencyKey,
    })).rejects.toMatchObject({ code: 'checked_mutation_result_invalid' });
    expect(failed.mutationExecutor.execute).not.toHaveBeenCalled();
  });

  it('waits for checker validation and durable read-back before returning a terminal mutation result', async () => {
    const events: string[] = [];
    let releaseChecker: (() => void) | undefined;
    const checkerValidated = new Promise<void>((resolve) => {
      releaseChecker = resolve;
    });
    const teamExecutor = {
      executeWorkCell: vi.fn(async () => {
        await checkerValidated;
        events.push('checker_validated');
        return journalChecked('journal');
      }),
    };
    const mutationExecutor = {
      execute: vi.fn(async (command: CheckedCommandV1) => {
        events.push('mutation_executed');
        return {
          status: 'readback_verified' as const,
          receipt: receiptFor(command),
          readback: readbackFor(command),
        };
      }),
    };
    const runtime = {
      complete: vi.fn(async () => {
        events.push('terminal_complete');
        return { status: 'verified' };
      }),
    };
    const ledger = {
      findTask: vi.fn(async () => {
        events.push('readback_verified');
        return { status: 'readback_verified' };
      }),
    };
    const coordinator = new CheckedMutationWorkCellCoordinator({
      teamExecutor: teamExecutor as never,
      mutationExecutor: mutationExecutor as never,
      runtime: runtime as never,
      ledger: ledger as never,
    });
    const service = new AccountingMutationService(coordinator);

    const execution = service.execute({
      workCellId: 'journal',
      workCellInput: {} as never,
      commandId,
      idempotencyKey,
    });
    await Promise.resolve();

    expect(teamExecutor.executeWorkCell).toHaveBeenCalledOnce();
    expect(mutationExecutor.execute).not.toHaveBeenCalled();
    releaseChecker?.();

    await expect(execution).resolves.toMatchObject({
      status: 'verified',
      completionState: 'terminal',
      mutation: { readback: { ok: true } },
    });
    expect(events).toEqual([
      'checker_validated',
      'mutation_executed',
      'readback_verified',
      'terminal_complete',
    ]);
  });
});

function setup(checked: unknown) {
  const teamExecutor = { executeWorkCell: vi.fn().mockResolvedValue(checked) };
  const mutationExecutor = { execute: vi.fn(async (command: CheckedCommandV1) => ({
    status: 'readback_verified',
    receipt: receiptFor(command),
    readback: readbackFor(command),
  })) };
  const runtime = { complete: vi.fn().mockResolvedValue({ status: 'verified' }) };
  const ledger = { findTask: vi.fn().mockResolvedValue({ status: 'readback_verified' }) };
  const coordinator = new CheckedMutationWorkCellCoordinator({
    teamExecutor: teamExecutor as never,
    mutationExecutor: mutationExecutor as never,
    runtime: runtime as never,
    ledger: ledger as never,
  });
  return {
    service: new AccountingMutationService(coordinator),
    teamExecutor,
    mutationExecutor,
    runtime,
  };
}

function journalChecked(
  workCellId: 'transaction-capture' | 'journal',
  output: JsonValue = journalProposal(),
) {
  const maker = {
    schemaName: 'maker-artifact' as const,
    schemaVersion: 1 as const,
    outputSchema: { schemaName: 'accounting-work-result', schemaVersion: 1 },
    output,
    claims: [{ claimId: 'checked-journal', text: 'Checked accounting mutation proposal.', evidenceArtifactIds: [] }],
    assumptions: [],
    uncertainty: [],
  };
  return checkedResult(workCellId, maker);
}

function chartChecked() {
  const maker = {
    schemaName: 'maker-artifact' as const,
    schemaVersion: 1 as const,
    outputSchema: { schemaName: 'chart-of-accounts-proposal', schemaVersion: 1 },
    output: {
      schemaName: 'chart-of-accounts-proposal',
      schemaVersion: 1,
      action: 'create_account',
      householdId,
      bookId,
      accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J3K',
      name: 'Groceries',
      accountingClass: 'expense',
      normalBalance: 'debit',
      nativeCurrency: 'USD',
    },
    claims: [{ claimId: 'checked-chart', text: 'Checked chart proposal.', evidenceArtifactIds: [] }],
    assumptions: [],
    uncertainty: [],
  };
  return checkedResult('chart-of-accounts', maker);
}

function chartClarificationChecked() {
  const maker = {
    schemaName: 'maker-artifact' as const,
    schemaVersion: 1 as const,
    outputSchema: { schemaName: 'chart-work-result', schemaVersion: 1 },
    output: {
      schemaName: 'chart-clarification',
      schemaVersion: 1,
      missingFields: ['name'],
      questions: ['What should the account be called?'],
      reason: 'An account name is required.',
    },
    claims: [{ claimId: 'chart-clarification', text: 'Account name is unresolved.', evidenceArtifactIds: [] }],
    assumptions: [],
    uncertainty: ['Missing name.'],
  };
  return {
    ...checkedResult('chart-of-accounts', maker),
    status: 'insufficient_evidence' as const,
    completionState: 'terminal' as const,
    acceptedMaker: undefined,
    completionReason: 'An account name is required.',
    outstanding: ['What should the account be called?'],
  };
}

function checkedResult(workCellId: string, maker: JsonValue) {
  const parsedMaker = MakerArtifactSchemaV1.parse(maker);
  const artifactHash = hashArtifact(maker);
  const artifact = {
    artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    householdId,
    taskId,
    artifactType: 'maker_output' as const,
    schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
    canonicalizationVersion: 'rfc8785-v1' as const,
    hashAlgorithm: 'sha256' as const,
    artifactHash,
    payload: maker,
    createdAt: now,
  };
  return {
    householdId,
    taskId,
    team: 'accounting',
    workCellId,
    status: 'verified' as const,
    completionState: 'checked_mutation_pending' as const,
    effectRequirement: {
      kind: 'checked_mutation' as const,
      proposalSchema: parsedMaker.outputSchema,
      confirmation: ChartOfAccountsProposalSchemaV1.safeParse(parsedMaker.output).success
        ? 'required' as const : 'optional' as const,
    },
    makerArtifacts: [artifact],
    checkerVerdicts: [{
      verdict: 'accepted' as const,
      coveredArtifactId: artifact.artifactId,
      coveredArtifactHash: artifact.artifactHash,
      findings: [],
    }],
    acceptedMaker: maker,
    completionReason: 'accepted',
    outstanding: [],
  };
}

function journalProposal() {
  return {
    schemaName: 'accounting-journal-mutation-proposal',
    schemaVersion: 1,
    operation: 'post',
    draft: {
      draftSeriesId: 'draftseries_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      version: 1,
      journal: {
        schemaName: 'post-journal-proposal',
        schemaVersion: 1,
        householdId,
        bookId,
        journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        periodId: 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        taskId,
        journalType: 'ordinary',
        transactionCurrency: 'USD',
        occurredOn: '2026-06-23',
        effectiveOn: '2026-06-23',
        description: 'Groceries paid from checking.',
        tagIds: [],
        postings: [
          {
            accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
            direction: 'debit',
            transactionAmount: '12.34',
            accountNativeAmount: '12.34',
            accountNativeCurrency: 'USD',
            tagIds: [],
          },
          {
            accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
            direction: 'credit',
            transactionAmount: '12.34',
            accountNativeAmount: '12.34',
            accountNativeCurrency: 'USD',
            tagIds: [],
          },
        ],
      },
    },
  };
}

function receiptFor(command: CheckedCommandV1): MutationReceiptV1 {
  return MutationReceiptSchemaV1.parse({
    schemaName: 'mutation-receipt',
    schemaVersion: 1,
    receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    commandId: command.commandId,
    householdId: command.householdId,
    taskId: command.taskId,
    commandType: command.commandType,
    idempotencyKey: command.idempotencyKey,
    checkedProposalId: command.checkedProposalId,
    checkedProposalHash: command.checkedProposalHash,
    committedRecords: [{ recordType: 'accounting.test', recordId: 'record-1' }],
    expectedState: { ok: true },
    expectedStateHash: 'b'.repeat(64),
    committedAt: now,
  });
}

function readbackFor(command: CheckedCommandV1): ReadbackResultV1 {
  return ReadbackResultSchemaV1.parse({
    schemaName: 'mutation-readback',
    schemaVersion: 1,
    readbackId: 'readback_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    commandId: command.commandId,
    receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    ok: true,
    checks: [{ kind: 'identifiers', status: 'passed' }],
    mismatches: [],
    observedStateHash: 'b'.repeat(64),
  });
}
