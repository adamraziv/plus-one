import { describe, expect, it, vi } from 'vitest';
import { CheckedCommandSchemaV1 } from '@plus-one/contracts';
import { hashArtifact } from '@plus-one/runtime';
import {
  CheckedMutationWorkCellCoordinator,
  type CheckedMutationCommandAdapter,
} from './checked-mutation-work-cell-coordinator.js';

const maker = {
  schemaName: 'maker-artifact' as const,
  schemaVersion: 1 as const,
  outputSchema: { schemaName: 'test-command-input', schemaVersion: 1 },
  output: { schemaName: 'test-command-input', schemaVersion: 1, amount: '20.00' },
  claims: [{ claimId: 'accepted', text: 'Checked proposal.', evidenceArtifactIds: [] }],
  assumptions: [],
  uncertainty: [],
};
const artifact = {
  artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  artifactType: 'maker_output' as const,
  schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
  canonicalizationVersion: 'rfc8785-v1' as const,
  hashAlgorithm: 'sha256' as const,
  artifactHash: hashArtifact(maker),
  payload: maker,
  createdAt: '2026-06-15T08:00:00.000Z',
};
const checked = {
  householdId: artifact.householdId,
  taskId: artifact.taskId,
  team: 'accounting',
  workCellId: 'transaction-capture',
  status: 'verified' as const,
  completionState: 'checked_mutation_pending' as const,
  effectRequirement: {
    kind: 'checked_mutation' as const,
    proposalSchema: { schemaName: 'test-command-input', schemaVersion: 1 },
    confirmation: 'required' as const,
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
const receipt = { receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K' };
const readback = { readbackId: 'readback_01JNZQ4A9B8C7D6E5F4G3H2J1K', ok: true };

function setup(execute = vi.fn().mockResolvedValue({
  status: 'readback_verified',
  receipt,
  readback,
})) {
  const teamExecutor = { executeWorkCell: vi.fn().mockResolvedValue(checked) };
  const runtime = { complete: vi.fn().mockResolvedValue({ status: 'verified' }) };
  const ledger = { findTask: vi.fn().mockResolvedValue({ status: 'readback_verified' }) };
  const adapter: CheckedMutationCommandAdapter = {
    buildCommand: vi.fn((input) => CheckedCommandSchemaV1.parse({
      schemaName: 'checked-command',
      schemaVersion: 1,
      commandId: input.commandId,
      householdId: input.householdId,
      taskId: input.taskId,
      commandType: 'test_command',
      checkedProposalId: input.checkedProposalId,
      checkedProposalHash: input.checkedProposalHash,
      idempotencyKey: input.idempotencyKey,
      payloadSchema: input.payloadSchema,
      payload: input.payload,
    })),
  };
  return {
    coordinator: new CheckedMutationWorkCellCoordinator({
      teamExecutor: teamExecutor as never,
      mutationExecutor: { execute } as never,
      runtime: runtime as never,
      ledger: ledger as never,
    }),
    teamExecutor,
    runtime,
    adapter,
    execute,
  };
}

describe('CheckedMutationWorkCellCoordinator', () => {
  it('builds from the exact maker envelope and verifies only after read-back', async () => {
    const { coordinator, teamExecutor, runtime, adapter, execute } = setup();
    const result = await coordinator.execute({
      workCellInput: {} as never,
      commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      confirmationId: 'confirm_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      adapter,
    });
    expect(teamExecutor.executeWorkCell).toHaveBeenCalledWith({});
    expect(adapter.buildCommand).toHaveBeenCalledWith(expect.objectContaining({
      checkedProposalId: artifact.artifactId,
      checkedProposalHash: artifact.artifactHash,
      payloadSchema: maker.outputSchema,
      payload: maker.output,
    }));
    expect(execute.mock.invocationCallOrder[0])
      .toBeLessThan(runtime.complete.mock.invocationCallOrder[0]!);
    expect(runtime.complete).toHaveBeenCalledWith({
      householdId: artifact.householdId,
      taskId: artifact.taskId,
      status: 'verified',
    });
    expect(result).toMatchObject({
      completionState: 'terminal',
      status: 'verified',
      mutation: { receipt, readback },
    });
  });

  it('never completes a work cell when execution or read-back fails', async () => {
    const failure = Object.assign(new Error('read-back failed'), { code: 'mutation_readback_failed' });
    const { coordinator, runtime, adapter } = setup(vi.fn().mockRejectedValue(failure));
    await expect(coordinator.execute({
      workCellInput: {} as never,
      commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      confirmationId: 'confirm_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      adapter,
    })).rejects.toBe(failure);
    expect(runtime.complete).not.toHaveBeenCalled();
  });

  it('prepares the exact checked command without executing it', async () => {
    const { coordinator, adapter, execute } = setup();
    const prepared = await coordinator.prepare({
      workCellInput: {} as never,
      commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      adapter,
    });

    expect(prepared.completionState).toBe('checked_mutation_pending');
    expect(prepared.command).toMatchObject({
      checkedProposalId: artifact.artifactId,
      checkedProposalHash: artifact.artifactHash,
      payloadSchema: { schemaName: 'test-command-input', schemaVersion: 1 },
      payload: maker.output,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes a prepared command only after adding the supplied confirmation identity', async () => {
    const { coordinator, adapter, execute } = setup();
    const prepared = await coordinator.prepare({
      workCellInput: {} as never,
      commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      adapter,
    });
    const result = await coordinator.executePrepared({
      prepared,
      confirmationId: 'confirm_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      confirmationId: 'confirm_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    }));
    expect(result.mutation.readback.ok).toBe(true);
  });

  it('resumes durable read-back evidence without rerunning the maker or checker', async () => {
    const { coordinator, teamExecutor, runtime, adapter } = setup();
    const command = adapter.buildCommand({
      commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      householdId: artifact.householdId,
      taskId: artifact.taskId,
      checkedProposalId: artifact.artifactId,
      checkedProposalHash: artifact.artifactHash,
      payloadSchema: maker.outputSchema,
      payload: maker.output,
    });
    await expect(coordinator.resume(command)).resolves.toEqual({ receipt, readback });
    expect(teamExecutor.executeWorkCell).not.toHaveBeenCalled();
    expect(runtime.complete).toHaveBeenCalledWith({
      householdId: artifact.householdId,
      taskId: artifact.taskId,
      status: 'verified',
    });
  });
});
