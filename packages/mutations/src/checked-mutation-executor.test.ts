import { describe, expect, it, vi } from 'vitest';
import { CheckedCommandSchemaV1 } from '@plus-one/contracts';
import { hashArtifact } from '@plus-one/runtime';
import { z } from 'zod';
import { CheckedMutationExecutor } from './checked-mutation-executor.js';
import { CommandRegistry } from './command-registry.js';

const proposal = { amount: '20.00' };
const makerArtifactPayload = {
  schemaName: 'maker-artifact' as const,
  schemaVersion: 1 as const,
  outputSchema: { schemaName: 'test-command-input', schemaVersion: 1 },
  output: proposal,
  claims: [{
    claimId: 'proposal-ready',
    text: 'Proposal is ready for checked execution.',
    evidenceArtifactIds: [],
  }],
  assumptions: [],
  uncertainty: [],
};
const command = CheckedCommandSchemaV1.parse({
  schemaName: 'checked-command',
  schemaVersion: 1,
  commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  commandType: 'test_command',
  checkedProposalId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  checkedProposalHash: hashArtifact(makerArtifactPayload),
  idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  payloadSchema: { schemaName: 'test-command-input', schemaVersion: 1 },
  payload: proposal,
});

function setup(readbackOk = true) {
  const execute = vi.fn();
  const handler = {
    commandType: 'test_command',
    domainRole: 'accounting' as const,
    inputSchema: z.object({ amount: z.string() }).strict(),
    inputSchemaIdentity: command.payloadSchema,
    confirmation: 'optional' as const,
    requiredReadbackChecks: [
      'identifiers',
      'row_values',
      'artifact_links',
      'idempotency_receipt',
    ] as const,
    execute,
    readback: vi.fn().mockResolvedValue({
      checks: [
        {
          kind: 'identifiers',
          status: readbackOk ? 'passed' : 'failed',
          ...(readbackOk ? {} : { detailCode: 'missing' }),
        },
        { kind: 'row_values', status: 'passed' },
        { kind: 'source_links', status: 'not_applicable' },
        { kind: 'artifact_links', status: 'passed' },
      ],
      mismatches: readbackOk ? [] : ['journal_missing'],
      observedState: { found: readbackOk },
    }),
  };
  const receipt = {
    schemaName: 'mutation-receipt' as const,
    schemaVersion: 1 as const,
    receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    commandId: command.commandId,
    householdId: command.householdId,
    taskId: command.taskId,
    checkedProposalId: command.checkedProposalId,
    checkedProposalHash: command.checkedProposalHash,
    commandType: command.commandType,
    idempotencyKey: command.idempotencyKey,
    committedRecords: [{ recordType: 'test.record', recordId: 'record_1' }],
    expectedState: { recordId: 'record_1' },
    expectedStateHash: 'b'.repeat(64),
    committedAt: '2026-06-15T08:00:00.000Z',
  };
  const commands = {
    register: vi.fn().mockResolvedValue({ ...command, status: 'registered' }),
    markExecutionPending: vi.fn(),
    markExecutionFailed: vi.fn(),
    findReceiptByCommand: vi.fn().mockResolvedValue(receipt),
    recordReadback: vi.fn(),
    findReadbackByCommand: vi.fn(),
  };
  const resolver = {
    reconcile: vi.fn()
      .mockResolvedValueOnce({ ...command, status: 'execution_pending' })
      .mockResolvedValueOnce({ ...command, status: 'committed' })
      .mockResolvedValue({ ...command, status: readbackOk ? 'readback_verified' : 'readback_failed' }),
  };
  const ledger = {
    findLatestVerdict: vi.fn().mockResolvedValue({
      verdict: 'accepted',
      coveredArtifactId: command.checkedProposalId,
      coveredArtifactHash: command.checkedProposalHash,
      findings: [],
    }),
    transition: vi.fn().mockImplementation(async (input) => ({ status: input.to })),
  };
  const executor = new CheckedMutationExecutor({
    artifacts: {
      getVerified: vi.fn().mockResolvedValue({
        artifactId: command.checkedProposalId,
        householdId: command.householdId,
        taskId: command.taskId,
        artifactType: 'maker_output',
        artifactHash: command.checkedProposalHash,
        schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
        payload: makerArtifactPayload,
        canonicalizationVersion: 'rfc8785-v1',
        hashAlgorithm: 'sha256',
        createdAt: '2026-06-15T08:00:00.000Z',
      }),
    } as never,
    ledger: ledger as never,
    commands: commands as never,
    resolver: resolver as never,
    registry: new CommandRegistry([handler]),
    runner: { run: vi.fn().mockResolvedValue(receipt) } as never,
    readClients: { connect: vi.fn().mockResolvedValue(fakeClient()) },
    newReadbackId: () => 'readback_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  });
  return { executor, handler, commands, resolver };
}

describe('CheckedMutationExecutor', () => {
  it('reports success only after command and task reach readback_verified', async () => {
    const { executor, commands, resolver } = setup(true);
    await expect(executor.execute(command)).resolves.toMatchObject({ status: 'readback_verified' });
    expect(commands.recordReadback).toHaveBeenCalledWith(command.householdId,
      expect.objectContaining({ ok: true }));
    expect(resolver.reconcile).toHaveBeenLastCalledWith(command.householdId, command.commandId);
  });

  it('records readback_failed and never executes the mutation handler again', async () => {
    const { executor, handler, commands, resolver } = setup(false);
    await expect(executor.execute(command)).rejects.toMatchObject({ category: 'readback_mismatch' });
    expect(handler.execute).not.toHaveBeenCalled();
    expect(commands.recordReadback).toHaveBeenCalledWith(command.householdId,
      expect.objectContaining({ ok: false }));
    expect(resolver.reconcile).toHaveBeenLastCalledWith(command.householdId, command.commandId);
  });

  it('rejects artifact hash drift before command registration', async () => {
    const { executor, commands } = setup(true);
    await expect(executor.execute({ ...command, checkedProposalHash: 'f'.repeat(64) }))
      .rejects.toMatchObject({ code: 'checked_proposal_identity_mismatch' });
    expect(commands.register).not.toHaveBeenCalled();
  });
});

function fakeClient() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  };
}
