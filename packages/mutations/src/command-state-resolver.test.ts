import { describe, expect, it, vi } from 'vitest';
import { CommandStateResolver } from './command-state-resolver.js';

const record = {
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
};

describe('CommandStateResolver', () => {
  it.each([
    ['registered', 'checker_validated', 'execution_pending'],
    ['execution_pending', 'checker_validated', 'execution_pending'],
    ['committed', 'execution_pending', 'committed'],
    ['readback_verified', 'committed', 'readback_verified'],
    ['execution_failed', 'execution_pending', 'execution_failed'],
    ['readback_failed', 'committed', 'readback_failed'],
  ] as const)('reconciles command %s with task %s', async (commandStatus, taskStatus, expected) => {
    const commands = {
      markExecutionPending: vi.fn(),
      findByCommandId: vi.fn()
        .mockResolvedValueOnce({ ...record, status: commandStatus })
        .mockResolvedValue({ ...record, status: expected }),
    };
    const ledger = {
      findTask: vi.fn().mockResolvedValue({ ...record, status: taskStatus }),
      transition: vi.fn().mockResolvedValue({ ...record, status: expected }),
    };
    const resolver = new CommandStateResolver({ commands: commands as never, ledger: ledger as never });
    await expect(resolver.reconcile(record.householdId, record.commandId))
      .resolves.toMatchObject({ status: expected });
  });

  it('rejects impossible task/command ordering instead of replaying', async () => {
    const resolver = new CommandStateResolver({
      commands: { findByCommandId: vi.fn().mockResolvedValue({
        ...record,
        status: 'execution_pending',
      }) } as never,
      ledger: { findTask: vi.fn().mockResolvedValue({ ...record, status: 'committed' }) } as never,
    });
    await expect(resolver.reconcile(record.householdId, record.commandId))
      .rejects.toMatchObject({ code: 'mutation_state_inconsistent' });
  });
});
