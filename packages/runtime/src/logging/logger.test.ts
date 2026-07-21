import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withLogContext } from './context.js';
import { configureLogging, getLogger } from './index.js';
import { sanitizeFields } from './redaction.js';

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'plus-one-logger-'));
}

describe('centralized logger', () => {
  it('writes safe records to agent.log and warnings to errors.log', async () => {
    const homeDirectory = await tempHome();
    const handle = configureLogging({ homeDirectory });
    const logger = getLogger('test.runtime');
    logger.info('turn.completed', { fields: { status: 'succeeded', durationMs: 12 } });
    logger.warn('delivery.failed', { fields: { status: 'failed' } });
    handle.close();

    const agent = await readFile(join(homeDirectory, 'logs', 'agent.log'), 'utf8');
    const errors = await readFile(join(homeDirectory, 'logs', 'errors.log'), 'utf8');
    expect(agent).toContain('INFO');
    expect(agent).toContain('turn.completed');
    expect(errors).toContain('delivery.failed');
    expect(errors).not.toContain('turn.completed');
  });

  it('routes only gateway components to gateway.log while retaining them in agent.log', async () => {
    const homeDirectory = await tempHome();
    const handle = configureLogging({ homeDirectory, mode: 'gateway' });
    getLogger('gateway.channel').info('gateway.inbound.accepted');
    getLogger('runtime.agent').info('agent.completed');
    handle.close();

    const gateway = await readFile(join(homeDirectory, 'logs', 'gateway.log'), 'utf8');
    const agent = await readFile(join(homeDirectory, 'logs', 'agent.log'), 'utf8');
    expect(gateway).toContain('gateway.inbound.accepted');
    expect(gateway).not.toContain('agent.completed');
    expect(agent).toContain('gateway.inbound.accepted');
    expect(agent).toContain('agent.completed');
  });

  it('does not duplicate handlers when configured twice', async () => {
    const homeDirectory = await tempHome();
    const first = configureLogging({ homeDirectory });
    const second = configureLogging({ homeDirectory });
    getLogger('test.runtime').info('runtime.started');
    second.close();
    first.close();

    const content = await readFile(join(homeDirectory, 'logs', 'agent.log'), 'utf8');
    expect(content.match(/runtime\.started/g)).toHaveLength(1);
  });

  it('rotates the base file when the configured size is exceeded', async () => {
    const homeDirectory = await tempHome();
    const handle = configureLogging({ homeDirectory, maxSizeMb: 0.001, backupCount: 1 });
    const logger = getLogger('test.rotation');
    for (let index = 0; index < 30; index += 1) {
      logger.info(`rotation.${index}`, { fields: { status: 'ok' } });
    }
    handle.close();

    await expect(stat(join(homeDirectory, 'logs', 'agent.log.1'))).resolves.toBeDefined();
  });

  it('honors environment settings and includes inherited context without content fields', async () => {
    const homeDirectory = await tempHome();
    expect(sanitizeFields({ token: 'secret-token', status: 'failed' })).toEqual({ status: 'failed' });
    const handle = configureLogging({
      environment: {
        PLUS_ONE_HOME: homeDirectory,
        PLUS_ONE_LOG_LEVEL: 'WARNING',
        PLUS_ONE_LOG_MAX_SIZE_MB: '1',
        PLUS_ONE_LOG_BACKUP_COUNT: '1',
      },
    });
    await withLogContext({ requestId: 'req_1', taskId: 'task_1' }, async () => {
      const logger = getLogger('test.context');
      logger.info('ignored.info');
      logger.warn('context.warning', {
        fields: { status: 'failed', body: 'private message', token: 'secret-token' },
      });
    });
    handle.close();

    const content = await readFile(join(homeDirectory, 'logs', 'agent.log'), 'utf8');
    expect(content).not.toContain('ignored.info');
    expect(content).toContain('context.warning');
    expect(content).toContain('requestId=req_1');
    expect(content).toContain('taskId=task_1');
    expect(content).not.toContain('private message');
    expect(content).not.toContain('secret-token');
  });

  it('falls back to stderr when the log directory cannot be created', () => {
    const write = vi.fn();
    const handle = configureLogging({ homeDirectory: '/dev/null', stderr: { write } });
    expect(() => getLogger('test.failure').warn('logging.warning')).not.toThrow();
    handle.close();
    expect(write).toHaveBeenCalledWith(expect.stringContaining('logging.file_sink_failed'));
  });
});
