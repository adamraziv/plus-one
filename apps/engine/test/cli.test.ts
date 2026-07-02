import { describe, expect, it, vi } from 'vitest';
import { runPlusOneCli } from '../src/cli.js';

describe('Plus One CLI', () => {
  const environment = {
    NODE_ENV: 'test',
    DATABASE_MIGRATOR_URL: 'postgresql://migrator:password@127.0.0.1:5432/plus_one',
    DATABASE_ACCOUNTING_URL: 'postgresql://accounting:password@127.0.0.1:5432/plus_one',
    DATABASE_PLANNING_URL: 'postgresql://planning:password@127.0.0.1:5432/plus_one',
    DATABASE_OPERATIONS_URL: 'postgresql://operations:password@127.0.0.1:5432/plus_one',
    DATABASE_QUERY_URL: 'postgresql://query:password@127.0.0.1:5432/plus_one',
    DATABASE_MEMORY_URL: 'postgresql://memory:password@127.0.0.1:5432/plus_one',
    PLUS_ONE_ACCOUNTING_PASSWORD: 'accounting-password',
    PLUS_ONE_PLANNING_PASSWORD: 'planning-password',
    PLUS_ONE_OPERATIONS_PASSWORD: 'operations-password',
    PLUS_ONE_QUERY_PASSWORD: 'query-password',
    PLUS_ONE_MEMORY_PASSWORD: 'memory-password',
  };

  it('activates Telegram pairing approval through the telegram pairing command', async () => {
    const write = vi.fn();
    const service = {
      approveCode: vi.fn(async () => ({
        status: 'approved' as const,
        principal: {
          id: 'principal-1',
          channel: 'telegram' as const,
          externalUserId: '1234567890123',
          externalChatId: '9876543210987',
          householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
          approvedAt: '2026-07-01T00:00:00.000Z',
          approvedBy: 'cli:test',
          metadata: {},
        },
      })),
      revoke: vi.fn(),
      listPending: vi.fn(),
    };

    await expect(runPlusOneCli(
      ['telegram', 'pairing', 'approve', 'ABCDEFGH', '--household', 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K'],
      {
        pairingService: service,
        approvedBy: 'cli:test',
        stdout: { write },
        stderr: { write: vi.fn() },
      },
    )).resolves.toBe(0);

    expect(service.approveCode).toHaveBeenCalledWith({
      code: 'ABCDEFGH',
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      approvedBy: 'cli:test',
    });
    expect(write).toHaveBeenCalledWith(
      'Approved Telegram user 1234567890123 for household hh_01JNZQ4A9B8C7D6E5F4G3H2J1K.\n',
    );
  });

  it('wires Telegram pairing commands to the operations repository when no service is injected', async () => {
    const write = vi.fn();
    const query = vi.fn(async () => ({ rows: [] }));
    const pools = {
      operations: { query },
    } as never;
    const closePools = vi.fn(async () => {});

    await expect(runPlusOneCli(['telegram', 'pairing', 'list-pending'], {
      environment,
      createPools: vi.fn(() => pools),
      closePools,
      stdout: { write },
      stderr: { write: vi.fn() },
    })).resolves.toBe(0);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM operations.channel_pairing_requests'), [
      'telegram',
      expect.any(String),
    ]);
    expect(closePools).toHaveBeenCalledWith(pools);
    expect(write).toHaveBeenCalledWith('No pending Telegram pairing requests.\n');
  });
});
