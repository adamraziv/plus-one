import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { SerializableMutationRunner } from './serializable-runner.js';

const command = {
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  commandType: 'test_command',
  checkedProposalId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  checkedProposalHash: 'a'.repeat(64),
  idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K',
} as const;

function handler(execute = vi.fn().mockResolvedValue({
  committedRecords: [{ recordType: 'test.record', recordId: 'record_1' }],
  expectedState: { recordId: 'record_1' },
})) {
  return {
    commandType: 'test_command',
    domainRole: 'accounting' as const,
    inputSchema: z.object({ amount: z.string() }),
    inputSchemaIdentity: { schemaName: 'test-command-input', schemaVersion: 1 },
    confirmation: 'optional' as const,
    requiredReadbackChecks: ['identifiers', 'idempotency_receipt'] as const,
    execute,
    readback: vi.fn(),
  };
}

describe('SerializableMutationRunner', () => {
  it('retries SQLSTATE 40001 with the same command and receipt identities', async () => {
    const first = fakeClient();
    first.query.mockRejectedValueOnce(Object.assign(new Error('serialize'), { code: '40001' }));
    const second = fakeClient();
    const bridge = {
      claim: vi.fn().mockResolvedValue({ status: 'execution_pending' }),
      commit: vi.fn().mockResolvedValue({
        receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        committedAt: '2026-06-15T08:00:00.000Z',
      }),
    };
    const runner = new SerializableMutationRunner({
      clients: { connect: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) },
      bridge: bridge as never,
      findReceipt: vi.fn(),
      sleep: vi.fn(),
      now: () => 0,
    });
    const result = await runner.run({
      command,
      handler: handler(),
      input: { amount: '20.00' },
      receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    });
    expect(result.receiptId).toBe('receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K');
    expect(bridge.commit).toHaveBeenCalledTimes(1);
  });

  it('does not execute the handler when claim reveals an existing commit', async () => {
    const execute = vi.fn();
    const receipt = { receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K' };
    const runner = new SerializableMutationRunner({
      clients: { connect: vi.fn().mockResolvedValue(fakeClient()) },
      bridge: {
        claim: vi.fn().mockResolvedValue({ status: 'committed', receiptId: receipt.receiptId }),
      } as never,
      findReceipt: vi.fn().mockResolvedValue(receipt),
      sleep: vi.fn(),
      now: () => 0,
    });
    await expect(runner.run({
      command,
      handler: handler(execute),
      input: { amount: '20.00' },
      receiptId: receipt.receiptId,
    })).resolves.toBe(receipt);
    expect(execute).not.toHaveBeenCalled();
  });

  it('resolves an ambiguous connection failure by receipt lookup before any retry', async () => {
    const client = fakeClient();
    client.query.mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') throw Object.assign(new Error('connection lost'), { code: '08006' });
      return { rows: [], rowCount: 0 };
    });
    const existing = { receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K' };
    const findReceipt = vi.fn().mockResolvedValue(existing);
    const runner = new SerializableMutationRunner({
      clients: { connect: vi.fn().mockResolvedValue(client) },
      bridge: {
        claim: vi.fn().mockResolvedValue({ status: 'execution_pending' }),
        commit: vi.fn().mockResolvedValue({
          receiptId: existing.receiptId,
          committedAt: '2026-06-15T08:00:00.000Z',
        }),
      } as never,
      findReceipt,
      sleep: vi.fn(),
      now: () => 0,
    });
    await expect(runner.run({
      command,
      handler: handler(),
      input: { amount: '20.00' },
      receiptId: existing.receiptId,
    })).resolves.toBe(existing);
    expect(findReceipt).toHaveBeenCalledTimes(1);
  });

  it('rolls back a non-retryable handler failure', async () => {
    const client = fakeClient();
    const execute = vi.fn().mockRejectedValue(new Error('handler failed'));
    const runner = new SerializableMutationRunner({
      clients: { connect: vi.fn().mockResolvedValue(client) },
      bridge: { claim: vi.fn().mockResolvedValue({ status: 'execution_pending' }) } as never,
      findReceipt: vi.fn(),
      sleep: vi.fn(),
      now: () => 0,
    });
    await expect(runner.run({
      command,
      handler: handler(execute),
      input: { amount: '20.00' },
      receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    })).rejects.toThrow();
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('fails before opening a transaction when the overall deadline is exhausted', async () => {
    const connect = vi.fn();
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(15_000);
    const runner = new SerializableMutationRunner({
      clients: { connect },
      bridge: {} as never,
      findReceipt: vi.fn(),
      sleep: vi.fn(),
      now,
    });
    await expect(runner.run({
      command,
      handler: handler(),
      input: { amount: '20.00' },
      receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    })).rejects.toMatchObject({ code: 'mutation_overall_timeout' });
    expect(connect).not.toHaveBeenCalled();
  });
});

function fakeClient() {
  return { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: vi.fn() };
}
