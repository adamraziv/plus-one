import { describe, expect, it, vi } from 'vitest';
import {
  ChartOfAccountsProposalSchemaV1,
} from '@plus-one/accounting';
import {
  InboundChannelMessageSchemaV1,
  MakerArtifactSchemaV1,
  TeamResultEnvelopeSchemaV2,
  type JsonValue,
  type TeamResultEnvelopeV2,
} from '@plus-one/contracts';
import type { TeamDefinition } from '@plus-one/runtime';
import { OrchestratorAgent, type OrchestratorTurnResult } from '../src/agents/orchestrator.js';
import { AccountingDelegateRequestSchemaV1 } from '../src/tools/delegate-team-schemas.js';
import type { OrchestratorTeamRuntime } from '../src/tools/delegate-team.js';
import { pendingChartResultFixture } from './helpers/pending-chart-result.js';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const conversationId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const now = '2026-07-16T00:00:00.000Z';

const accountingTeam: TeamDefinition = {
  team: 'accounting',
  lead: {
    identity: { roleName: 'accounting-lead', roleVersion: 1 },
    kind: 'lead',
    agentId: 'accounting-lead',
    runtimePolicy: { policyName: 'accounting-lead', policyVersion: 1 },
  },
  charter: 'Convert explicit accounting instructions into checked mutation work.',
  prohibitedBehavior: [],
  workCells: [],
  allowedStrategyNames: ['single-maker-checker'],
};

describe('transaction category transcript flow', () => {
  it('suggests existing categories, offers category creation, and retains the transaction draft', async () => {
    const categoryPending = pendingCategoryResult();
    const transactionRequests: Array<ReturnType<typeof AccountingDelegateRequestSchemaV1.parse>['request']> = [];
    const resumePendingMutation = vi.fn(async () => persistedCategoryResult(categoryPending));
    const runTeamLead = vi.fn(async (input: Parameters<OrchestratorTeamRuntime['runTeamLead']>[0]) => {
      const request = AccountingDelegateRequestSchemaV1.parse(input.request);
      if (request.intent === 'chart_of_accounts') return categoryPending;
      if (request.intent !== 'transaction_capture') throw new Error('Unexpected accounting intent.');
      transactionRequests.push(request.request);
      return transactionRequests.length === 1
        ? categoryClarification(undefined)
        : transactionRequests.length === 2
          ? categoryClarification('dining')
          : recordedResult('The dining transaction was recorded.');
    });
    let transactionDelegations = 0;
    const generate = vi.fn(async (_prompt: unknown, options?: { toolChoice?: unknown }) => {
      if (options?.toolChoice === 'none') {
        return { text: 'I recorded USD 50.00 from test wallet on 2026-07-15 under Dining.' };
      }
      if (transactionDelegations === 0) {
        transactionDelegations += 1;
        await executeDelegate(orchestrator, {
          team: 'accounting',
          request: transactionDraft('Add a transaction to test wallet.', {
            paymentAccountName: 'test wallet',
          }),
        });
        return { text: 'I need a few more details.' };
      }
      if (transactionDelegations === 1) {
        transactionDelegations += 1;
        await executeDelegate(orchestrator, {
          team: 'accounting',
          request: transactionDraft('Record the transaction.', {
            amount: '50.00',
            currency: 'USD',
            occurredOn: '2026-07-15',
            categoryName: 'dining',
          }),
        });
        return { text: 'I found the transaction details.' };
      }
      await executeDelegate(orchestrator, {
        team: 'accounting',
        request: chartDraft(),
      });
      return { text: 'I have a category change ready.' };
    });
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      teams: [accountingTeam],
      teamRuntime: {
        runTeamLead,
        resumePendingMutation,
        cancelPendingMutation: vi.fn(),
      },
    });

    const transcript: string[] = [];
    const first = requireAskUser(await orchestrator.runTurn({ message: message('add a transaction to test wallet', 1) }));
    transcript.push(`Adam: add a transaction to test wallet\nPlus One Testing: ${first.response.body}`);
    expect(first.kind).toBe('ask-user');
    expect(first.response.body).toContain('Food and Groceries');
    expect(first.response.body).toContain('add a new category');

    const second = requireAskUser(await orchestrator.runTurn({
      message: message('50 usd, yesterday, dining', 2),
      transactionContinuation: requireTransactionContinuation(first),
    }));
    transcript.push(`Adam: 50 usd, yesterday, dining\nPlus One Testing: ${second.response.body}`);
    expect(second.kind).toBe('ask-user');
    expect(second.response.body).toContain('I don’t have a "dining" category yet.');
    expect(second.response.body).toContain('Existing transaction categories include Food and Groceries.');
    expect(second.response.body).not.toBe('What category should I use for this transaction?');

    const third = requireAskUser(await orchestrator.runTurn({
      message: message('add a new category', 3),
      transactionContinuation: requireTransactionContinuation(second),
    }));
    transcript.push(`Adam: add a new category\nPlus One Testing: ${third.response.body}`);
    expect(third.kind).toBe('ask-user');
    expect(third.response.body).toContain('Dining');
    expect(third.response.body).toContain('USD');
    expect(third.response.body).toContain('50.00');
    expect(third.response.body).toContain('test wallet');
    expect(third.response.body).toContain('Would you like me to proceed?');

    const fourth = await orchestrator.resolvePendingMutation({
      message: message('yes', 4),
      pending: requirePendingMutation(third),
      transactionContinuation: requireTransactionContinuation(third),
    });
    transcript.push(`Adam: yes\nPlus One Testing: ${fourth.response.body}`);
    expect(fourth.kind).toBe('final');
    expect(fourth.response.body).toBe('I recorded USD 50.00 from test wallet on 2026-07-15 under Dining.');
    expect(resumePendingMutation).toHaveBeenCalledOnce();
    expect(transactionRequests.at(-1)).toMatchObject({
      schemaName: 'transaction-capture-request-draft',
      known: {
        amount: '50.00',
        currency: 'USD',
        occurredOn: '2026-07-15',
        paymentAccountName: 'test wallet',
        categoryName: 'Dining',
      },
    });

    console.info(`\n${transcript.join('\n\n')}\n`);
  });
});

function message(body: string, ordinal: number) {
  return InboundChannelMessageSchemaV1.parse({
    schemaName: 'inbound-channel-message',
    schemaVersion: 1,
    conversationId,
    householdId,
    channel: 'telegram',
    externalMessageId: `telegram-category-live-${ordinal}`,
    receivedAt: now,
    speaker: { principalRef: 'telegram:user:1' },
    body,
    attachments: [],
    metadata: { destination: { chatId: 'telegram-chat-42' } },
  });
}

function transactionDraft(instruction: string, known: Record<string, string>) {
  return {
    schemaName: 'accounting-lead-request',
    schemaVersion: 1,
    intent: 'transaction_capture',
    request: {
      schemaName: 'transaction-capture-request-draft',
      schemaVersion: 1,
      instruction,
      known,
    },
  } satisfies JsonValue;
}

function chartDraft() {
  return {
    schemaName: 'accounting-lead-request',
    schemaVersion: 1,
    intent: 'chart_of_accounts',
    request: {
      schemaName: 'chart-work-request-draft',
      schemaVersion: 1,
      action: 'create_account',
      instruction: 'Add Dining as a new spending category.',
      known: {
        accountName: 'Dining',
        accountingClass: 'expense',
        normalBalance: 'debit',
        nativeCurrency: 'USD',
      },
    },
  } satisfies JsonValue;
}

function categoryClarification(categoryName: string | undefined): TeamResultEnvelopeV2 {
  const questions = categoryName === undefined
    ? [
        'What amount should be recorded?',
        'What currency should be used?',
        'On what date did the transaction occur?',
        'Which transaction category should I use? Existing categories include Food and Groceries. You can also ask me to add a new category.',
      ]
    : [`I don’t have a "${categoryName}" category yet. Existing transaction categories include Food and Groceries. Should I use one of those, or add a new category?`];
  const question = questions.at(-1)!;
  const artifact = pendingChartResultFixture.makerArtifacts[0]!;
  const payload = MakerArtifactSchemaV1.parse(artifact.payload);
  return TeamResultEnvelopeSchemaV2.parse({
    ...pendingChartResultFixture,
    status: 'insufficient_evidence',
    claims: [],
    makerArtifacts: [{
      ...artifact,
      payload: MakerArtifactSchemaV1.parse({
        ...payload,
        outputSchema: { schemaName: 'accounting-work-result', schemaVersion: 1 },
        output: {
          schemaName: 'accounting-clarification',
          schemaVersion: 1,
          missingFields: categoryName === undefined
            ? ['amount', 'currency', 'occurred_on', 'category']
            : ['category'],
          questions,
          reason: 'The requested category is not resolved to an existing spending category.',
        },
      }),
    }],
    completionReason: 'The requested category is not resolved to an existing spending category.',
    outstanding: [question],
    effect: { state: 'none' },
  });
}

function recordedResult(claimText: string): TeamResultEnvelopeV2 {
  const result = categoryClarification('dining');
  const artifactId = result.makerArtifacts[0]!.artifactId;
  return TeamResultEnvelopeSchemaV2.parse({
    ...result,
    status: 'verified',
    claims: [{
      claimId: 'transaction-recorded',
      text: claimText,
      evidenceArtifactIds: [],
      checkedMakerArtifactIds: [artifactId],
    }],
    outstanding: [],
    completionReason: claimText,
  });
}

function pendingCategoryResult(): TeamResultEnvelopeV2 {
  if (pendingChartResultFixture.effect.state !== 'awaiting_confirmation') {
    throw new Error('Expected a pending chart fixture.');
  }
  const payload = MakerArtifactSchemaV1.parse(pendingChartResultFixture.makerArtifacts[0]!.payload);
  const proposal = ChartOfAccountsProposalSchemaV1.parse(payload.output);
  const categoryProposal = ChartOfAccountsProposalSchemaV1.parse({
    ...proposal,
    name: 'Dining',
    accountingClass: 'expense',
    normalBalance: 'debit',
    nativeCurrency: 'USD',
  });
  const artifact = pendingChartResultFixture.makerArtifacts[0]!;
  return TeamResultEnvelopeSchemaV2.parse({
    ...pendingChartResultFixture,
    makerArtifacts: [{
      ...artifact,
      payload: MakerArtifactSchemaV1.parse({ ...payload, output: categoryProposal }),
    }],
    effect: {
      ...pendingChartResultFixture.effect,
      command: {
        ...pendingChartResultFixture.effect.command,
        payload: categoryProposal,
      },
    },
  });
}

function persistedCategoryResult(pending: TeamResultEnvelopeV2): TeamResultEnvelopeV2 {
  if (pending.effect.state !== 'awaiting_confirmation') throw new Error('Expected a pending category result.');
  const proposal = ChartOfAccountsProposalSchemaV1.parse(pending.effect.command.payload);
  return TeamResultEnvelopeSchemaV2.parse({
    ...pending,
    status: 'verified',
    completionReason: 'The checked category was created and read back successfully.',
    effect: {
      state: 'persisted',
      proposal: pending.effect.proposal,
      receipt: {
        schemaName: 'mutation-receipt',
        schemaVersion: 1,
        receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        commandId: pending.effect.command.commandId,
        householdId: pending.householdId,
        taskId: pending.taskId,
        checkedProposalId: pending.effect.proposal.artifactId,
        checkedProposalHash: pending.effect.proposal.artifactHash,
        commandType: pending.effect.command.commandType,
        idempotencyKey: pending.effect.command.idempotencyKey,
        committedRecords: [{ recordType: 'accounting.account', recordId: proposal.accountId }],
        expectedState: pending.effect.command.payload,
        expectedStateHash: 'c'.repeat(64),
        committedAt: now,
      },
      readback: {
        schemaName: 'mutation-readback',
        schemaVersion: 1,
        readbackId: 'readback_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        commandId: pending.effect.command.commandId,
        receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        ok: true,
        checks: [{ kind: 'idempotency_receipt', status: 'passed' }],
        mismatches: [],
        observedStateHash: 'd'.repeat(64),
      },
    },
  });
}

async function executeDelegate(
  orchestrator: OrchestratorAgent,
  input: { team: string; request: JsonValue },
): Promise<TeamResultEnvelopeV2> {
  const execute = orchestrator.agentTools.delegateTeam.execute as unknown as (
    value: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return TeamResultEnvelopeSchemaV2.parse(await execute(input, {}));
}

function requireAskUser(result: OrchestratorTurnResult) {
  if (result.kind !== 'ask-user') throw new Error('Expected the transcript turn to ask the user.');
  return result;
}

function requireTransactionContinuation(result: OrchestratorTurnResult) {
  const askUser = requireAskUser(result);
  if (askUser.transactionContinuation === undefined) {
    throw new Error('Expected the transcript turn to retain the transaction draft.');
  }
  return askUser.transactionContinuation;
}

function requirePendingMutation(result: OrchestratorTurnResult) {
  const askUser = requireAskUser(result);
  if (askUser.pendingMutation === undefined) throw new Error('Expected a pending category mutation.');
  return askUser.pendingMutation;
}
