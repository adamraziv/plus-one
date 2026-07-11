import { describe, expect, it, vi } from 'vitest';
import { runPlusOneCli } from '../src/cli.js';
import { runLiveCli } from '../src/live-cli/index.js';

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

  it('starts the gateway runtime when no arguments are supplied', async () => {
    const runGateway = vi.fn(async () => 0);
    const runLiveCli = vi.fn(async () => 0);
    const stdout = { isTTY: false, write: vi.fn() };
    const stderr = { isTTY: false, write: vi.fn() };

    await expect(runPlusOneCli([], {
      runGateway,
      runLiveCli,
      stdout,
      stderr,
    })).resolves.toBe(0);

    expect(runGateway).toHaveBeenCalledWith(expect.objectContaining({ stdout, stderr }));
    expect(runLiveCli).not.toHaveBeenCalled();
  });

  it('dispatches the logs command without starting application resources', async () => {
    const runLogs = vi.fn(async () => 0);
    const runGateway = vi.fn(async () => 0);
    const runLiveCli = vi.fn(async () => 0);

    await expect(runPlusOneCli(['logs', 'gateway'], {
      runLogs,
      runGateway,
      runLiveCli,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    })).resolves.toBe(0);

    expect(runLogs).toHaveBeenCalledWith(['gateway'], expect.objectContaining({
      stdout: expect.any(Object), stderr: expect.any(Object),
    }));
    expect(runGateway).not.toHaveBeenCalled();
    expect(runLiveCli).not.toHaveBeenCalled();
  });

  it('prints gateway startup errors instead of rejecting', async () => {
    const error = new Error('Storage is unavailable');
    const runGateway = vi.fn(async () => {
      throw error;
    });
    const stderr = { write: vi.fn() };

    await expect(runPlusOneCli([], {
      runGateway,
      stdout: { write: vi.fn() },
      stderr,
    })).resolves.toBe(1);

    expect(stderr.write).toHaveBeenCalledWith('Storage is unavailable\n');
  });

  it('opens the live CLI through the explicit live command', async () => {
    const runGateway = vi.fn(async () => 0);
    const runLiveCli = vi.fn(async () => 0);

    await expect(runPlusOneCli(['live'], {
      runGateway,
      runLiveCli,
      stdout: { isTTY: true, write: vi.fn() },
      stderr: { write: vi.fn() },
    })).resolves.toBe(0);

    expect(runLiveCli).toHaveBeenCalledOnce();
    expect(runGateway).not.toHaveBeenCalled();
  });

  it('prints live CLI startup errors instead of rejecting', async () => {
    const error = new Error('Storage is unavailable');
    const runLiveCli = vi.fn(async () => {
      throw error;
    });
    const stderr = { write: vi.fn() };

    await expect(runPlusOneCli(['live'], {
      runLiveCli,
      stdout: { isTTY: true, write: vi.fn() },
      stderr,
    })).resolves.toBe(1);

    expect(stderr.write).toHaveBeenCalledWith('Storage is unavailable\n');
  });

  it('keeps direct Telegram pairing commands on the non-TUI path', async () => {
    const service = {
      approveCode: vi.fn(),
      revoke: vi.fn(async () => undefined),
      listPending: vi.fn(),
    };
    const runLiveCli = vi.fn(async () => 0);
    const write = vi.fn();

    await expect(runPlusOneCli(['telegram', 'pairing', 'revoke', '1234567890123'], {
      isInteractive: true,
      runLiveCli,
      pairingService: service,
      stdout: { isTTY: true, write },
      stderr: { write: vi.fn() },
    })).resolves.toBe(0);

    expect(runLiveCli).not.toHaveBeenCalled();
    expect(service.revoke).toHaveBeenCalledWith({ externalUserId: '1234567890123' });
    expect(write).toHaveBeenCalledWith('Revoked Telegram user 1234567890123.\n');
  });

  it('prints usage from the live CLI runner before opening resources when stdout is non-interactive', async () => {
    const write = vi.fn();

    await expect(runLiveCli({
      environment: {},
      stdout: { isTTY: false, write: vi.fn() },
      stderr: { write },
    })).resolves.toBe(1);

    expect(write).toHaveBeenCalledWith(
      'Usage: plus-one telegram pairing approve <code> --household <household_id> | revoke <telegram_user_id> | list-pending\n',
    );
  });
});
