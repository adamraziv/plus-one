import { createHash } from 'node:crypto';
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
    const configureLogging = vi.fn(() => ({
      logDirectory: '/tmp/plus-one-test-logs',
      flush: vi.fn(),
      close: vi.fn(),
    }));

    await expect(runPlusOneCli(['telegram', 'pairing', 'list-pending'], {
      environment,
      createPools: vi.fn(() => pools),
      closePools,
      configureLogging,
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

  it('keeps CLI-owned pools open until Telegram pairing approval settles', async () => {
    const code = 'ABCDEFGH';
    const salt = 'pairing-salt';
    const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
    const approvedAt = new Date('2026-07-01T00:00:00.000Z');
    const pending = {
      id: '1',
      channel: 'telegram',
      external_user_id: '1234567890123',
      external_chat_id: '9876543210987',
      code_hash: createHash('sha256').update(`${salt}:${code}`).digest('hex'),
      code_salt: salt,
      display_name: 'Test User',
      username: 'test_user',
      expires_at: new Date('2026-07-01T01:00:00.000Z'),
      consumed_at: null,
      last_sent_at: approvedAt,
      failed_approval_attempt_count: 0,
      approval_locked_until: null,
      metadata: {},
    };
    const lifecycle: string[] = [];
    let poolsClosed = false;
    const clientQuery = vi.fn(async (text: string) => {
      if (text === 'COMMIT') lifecycle.push('commit');
      if (text.includes('UPDATE operations.channel_pairing_requests')) return { rows: [pending] };
      if (text.includes('INSERT INTO operations.channel_principals')) {
        return {
          rows: [{
            id: 'principal-1',
            channel: 'telegram',
            external_user_id: pending.external_user_id,
            external_chat_id: pending.external_chat_id,
            household_id: householdId,
            display_name: pending.display_name,
            username: pending.username,
            approved_at: approvedAt,
            approved_by: 'cli:test',
            revoked_at: null,
            metadata: {},
          }],
        };
      }
      return { rows: [] };
    });
    const operations = {
      query: vi.fn(async () => {
        lifecycle.push('list:start');
        await Promise.resolve();
        lifecycle.push('list:finish');
        return { rows: [pending] };
      }),
      connect: vi.fn(async () => {
        lifecycle.push('connect');
        if (poolsClosed) throw new Error('Cannot use a pool after calling end on the pool');
        return { query: clientQuery, release: vi.fn() };
      }),
    };
    const pools = { operations } as never;
    const closePools = vi.fn(async () => {
      lifecycle.push('close');
      poolsClosed = true;
    });
    const write = vi.fn();

    const status = await runPlusOneCli(
      ['telegram', 'pairing', 'approve', code, '--household', householdId],
      {
        environment,
        createPools: vi.fn(() => pools),
        closePools,
        configureLogging: vi.fn(() => ({
          logDirectory: '/tmp/plus-one-test-logs',
          flush: vi.fn(),
          close: vi.fn(),
        })),
        approvedBy: 'cli:test',
        stdout: { write },
        stderr: { write: vi.fn() },
      },
    );

    expect(lifecycle).toEqual(['list:start', 'list:finish', 'connect', 'commit', 'close']);
    expect(status).toBe(0);
    expect(write).toHaveBeenCalledWith(
      `Approved Telegram user ${pending.external_user_id} for household ${householdId}.\n`,
    );
  });

  it('starts the gateway runtime when no arguments are supplied', async () => {
    const runDaemonStart = vi.fn(async () => 0);
    const runLiveCli = vi.fn(async () => 0);
    const stdout = { isTTY: false, write: vi.fn() };
    const stderr = { isTTY: false, write: vi.fn() };

    await expect(runPlusOneCli([], {
      runDaemonStart,
      runLiveCli,
      stdout,
      stderr,
    })).resolves.toBe(0);

    expect(runDaemonStart).toHaveBeenCalledWith(expect.objectContaining({ stdout, stderr }));
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

  it('keeps foreground gateway and daemon controls operational', async () => {
    const runForegroundGateway = vi.fn(async () => 0);
    const runDaemonStop = vi.fn(async () => 0);
    const runDaemonStatus = vi.fn(async () => 0);
    const output = { write: vi.fn() };

    await expect(runPlusOneCli(['--foreground'], {
      runForegroundGateway,
      stdout: output,
      stderr: output,
    })).resolves.toBe(0);
    await expect(runPlusOneCli(['stop'], {
      runDaemonStop,
      stdout: output,
      stderr: output,
    })).resolves.toBe(0);
    await expect(runPlusOneCli(['status'], {
      runDaemonStatus,
      stdout: output,
      stderr: output,
    })).resolves.toBe(0);

    expect(runForegroundGateway).toHaveBeenCalledOnce();
    expect(runDaemonStop).toHaveBeenCalledOnce();
    expect(runDaemonStatus).toHaveBeenCalledOnce();
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

  it('rejects chat as a CLI command', async () => {
    const runGateway = vi.fn(async () => 0);
    const stderr = { write: vi.fn() };

    await expect(runPlusOneCli(['chat', 'hello'], {
      runGateway,
      stdout: { write: vi.fn() },
      stderr,
    })).resolves.toBe(1);

    expect(runGateway).not.toHaveBeenCalled();
    expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining('Usage: plus-one'));
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
