import { describe, expect, it, vi } from 'vitest';
import { MutationReceiptSchemaV1, ReadbackResultSchemaV1 } from '@plus-one/contracts';
import { DefaultChartMutationRuntime } from '../../src/accounting/chart-mutation-runtime.js';
import {
  confirmationMessageFixture as message,
  pendingChartResultFixture as pendingTeamResult,
  pendingEffectFixture as pendingEffect,
} from '../helpers/pending-chart-result.js';

const prepareInput = { workCellInput: {} as never, resultMetadata: {} as never };

function setupChartMutationRuntime() {
  const prepared = { command: pendingEffect.command } as never;
  const receipt = MutationReceiptSchemaV1.parse({
    schemaName: 'mutation-receipt',
    schemaVersion: 1,
    receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    commandId: pendingEffect.command.commandId,
    householdId: message.householdId,
    taskId: pendingEffect.proposal.taskId,
    checkedProposalId: pendingEffect.proposal.artifactId,
    checkedProposalHash: pendingEffect.proposal.artifactHash,
    commandType: pendingEffect.command.commandType,
    idempotencyKey: pendingEffect.command.idempotencyKey,
    committedRecords: [{ recordType: 'accounting.account', recordId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K' }],
    expectedState: {},
    expectedStateHash: 'c'.repeat(64),
    committedAt: '2026-07-16T00:00:01.000Z',
  });
  const readback = ReadbackResultSchemaV1.parse({
    schemaName: 'mutation-readback',
    schemaVersion: 1,
    readbackId: 'readback_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    commandId: receipt.commandId,
    receiptId: receipt.receiptId,
    ok: true,
    checks: [{ kind: 'idempotency_receipt', status: 'passed' }],
    mismatches: [],
    observedStateHash: 'd'.repeat(64),
  });
  const commands = { recordConfirmation: vi.fn() };
  const coordinator = { resume: vi.fn().mockResolvedValue({ receipt, readback }) };
  const runtime = new DefaultChartMutationRuntime({
    service: { prepareChart: vi.fn().mockResolvedValue(prepared) } as never,
    assembler: { assemble: vi.fn(() => pendingTeamResult) } as never,
    commands,
    coordinator,
    verification: { complete: vi.fn() } as never,
    nextCommandId: () => pendingEffect.command.commandId,
    nextIdempotencyKey: () => pendingEffect.command.idempotencyKey,
    nextConfirmationId: () => 'confirm_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  });
  return { runtime, commands, coordinator };
}

describe('ChartMutationRuntime', () => {
  it('returns awaiting-confirmation without executing or recording confirmation', async () => {
    const harness = setupChartMutationRuntime();
    const result = await harness.runtime.prepare(prepareInput);
    expect(result).toMatchObject({
      status: 'partial',
      effect: { state: 'awaiting_confirmation' },
    });
    expect(harness.commands.recordConfirmation).not.toHaveBeenCalled();
    expect(harness.coordinator.resume).not.toHaveBeenCalled();
  });

  it('records the exact inbound observation and returns persisted proof after resume', async () => {
    const harness = setupChartMutationRuntime();
    const result = await harness.runtime.resume({ message, pending: pendingTeamResult });
    expect(harness.commands.recordConfirmation).toHaveBeenCalledWith(expect.objectContaining({
      householdId: message.householdId,
      taskId: pendingEffect.proposal.taskId,
      checkedProposalId: pendingEffect.proposal.artifactId,
      checkedProposalHash: pendingEffect.proposal.artifactHash,
      principalId: message.speaker.principalRef,
      channel: message.channel,
      channelReference: message.externalMessageId,
    }));
    expect(result).toMatchObject({
      status: 'verified',
      effect: { state: 'persisted', readback: { ok: true } },
    });
  });
});
