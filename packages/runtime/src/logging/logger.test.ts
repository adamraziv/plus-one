import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withLogContext } from './context.js';
import { configureLogging, getLogger } from './logger.js';
import { parseLogEnvelope } from './ndjson.js';
import type { LogEnvelopeV1, LogSink } from './types.js';

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'plus-one-logger-'));
}

async function records(path: string): Promise<LogEnvelopeV1[]> {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => parseLogEnvelope(line))
    .filter((record): record is LogEnvelopeV1 => record !== undefined);
}

function assertCatalogLoggerTyping(): void {
  const agentLogger = getLogger('runtime.agent');
  agentLogger.info('agent.completed', {
    fields: {
      role: 'journal_maker',
      model: 'provider/model',
      attemptOrdinal: 1,
      durationMs: 10,
    },
  });
  agentLogger.info('agent.completed', {
    fields: {
      role: 'journal_maker',
      model: 'provider/model',
      attemptOrdinal: 1,
      durationMs: 10,
      // @ts-expect-error agent.completed does not declare an unknownField attribute.
      unknownField: 'private',
    },
  });
  // @ts-expect-error agent.completed requires durationMs.
  agentLogger.info('agent.completed', {
    fields: {
      role: 'journal_maker',
      model: 'provider/model',
      attemptOrdinal: 1,
    },
  });
}
void assertCatalogLoggerTyping;

describe('centralized logger', () => {
  it('writes canonical records to agent.log and WARN/ERROR to errors.log', async () => {
    const homeDirectory = await tempHome();
    const handle = configureLogging({ homeDirectory, instanceId: 'instance_test' });
    getLogger('runtime.orchestrator').info('turn.completed', {
      fields: { status: 'final', durationMs: 12 },
    });
    getLogger('runtime.delivery').error('delivery.failed', {
      fields: {
        channel: 'telegram',
        status: 'failed',
        failureCategory: 'transport_failed',
        sent: true,
        durationMs: 20,
      },
      error: new Error('safe failure'),
    });
    await handle.close();

    const agent = await records(join(homeDirectory, 'logs', 'agent.log'));
    const errors = await records(join(homeDirectory, 'logs', 'errors.log'));
    expect(agent).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventName: 'turn.completed', severityText: 'INFO' }),
      expect.objectContaining({ eventName: 'delivery.failed', severityText: 'ERROR' }),
    ]));
    expect(errors.map(({ eventName }) => eventName)).toEqual(['delivery.failed']);
  });

  it('routes gateway.channel and engine.gateway to gateway.log while retaining them in agent.log', async () => {
    const homeDirectory = await tempHome();
    const handle = configureLogging({ homeDirectory, mode: 'gateway' });
    getLogger('gateway.channel').info('gateway.inbound.accepted', {
      fields: { channel: 'telegram' },
    });
    getLogger('engine.gateway').info('runtime.started', {
      fields: { mode: 'gateway' },
    });
    getLogger('runtime.agent').info('agent.completed', {
      fields: {
        role: 'journal_maker',
        model: 'provider/model',
        attemptOrdinal: 1,
        durationMs: 10,
      },
    });
    await handle.close();

    const gateway = await records(join(homeDirectory, 'logs', 'gateway.log'));
    const agent = await records(join(homeDirectory, 'logs', 'agent.log'));
    expect(gateway.map(({ eventName }) => eventName)).toEqual([
      'gateway.inbound.accepted',
      'runtime.started',
    ]);
    expect(agent.map(({ eventName }) => eventName)).toEqual([
      'gateway.inbound.accepted',
      'runtime.started',
      'agent.completed',
    ]);
  });

  it('routes launcher events only to launcher.log', async () => {
    const homeDirectory = await tempHome();
    const handle = configureLogging({ homeDirectory, mode: 'launcher' });
    getLogger('engine.gateway.launcher').info('launcher.started');
    await handle.close();

    expect((await records(join(homeDirectory, 'logs', 'launcher.log')))[0]?.eventName).toBe('launcher.started');
    await expect(stat(join(homeDirectory, 'logs', 'agent.log'))).rejects.toThrow();
    await expect(stat(join(homeDirectory, 'logs', 'gateway.log'))).rejects.toThrow();
  });

  it('is idempotent for the same directory and mode', async () => {
    const homeDirectory = await tempHome();
    const first = configureLogging({ homeDirectory, mode: 'gateway' });
    const second = configureLogging({ homeDirectory, mode: 'gateway' });
    expect(second).toBe(first);
    getLogger('engine.gateway').info('runtime.started', {
      fields: { mode: 'gateway' },
    });
    await second.close();
    await first.close();

    expect(await records(join(homeDirectory, 'logs', 'agent.log'))).toHaveLength(1);
  });

  it('honors WARNING as a WARN alias and emits dotted inherited context', async () => {
    const homeDirectory = await tempHome();
    const handle = configureLogging({
      environment: {
        NODE_ENV: 'test',
        PLUS_ONE_HOME: homeDirectory,
        PLUS_ONE_LOG_LEVEL: 'WARNING',
        PLUS_ONE_LOG_MAX_SIZE_MB: '1',
        PLUS_ONE_LOG_BACKUP_COUNT: '1',
      },
    });
    await withLogContext({ requestId: 'req_1', taskId: 'task_1' }, async () => {
      getLogger('runtime.orchestrator').info('turn.completed', {
        fields: { status: 'final', durationMs: 1 },
      });
      getLogger('runtime.orchestrator').warn('orchestrator.response.withheld', {
        fields: { matchCategory: 'unsafe' },
      });
    });
    await handle.close();

    const agent = await records(join(homeDirectory, 'logs', 'agent.log'));
    expect(agent).toHaveLength(1);
    expect(agent[0]).toMatchObject({
      severityText: 'WARN',
      severityNumber: 13,
      attributes: {
        'request.id': 'req_1',
        'plus_one.task.id': 'task_1',
        'match.category': 'unsafe',
      },
    });
  });

  it('uses a stable instance ID and replaces invalid events safely', async () => {
    const homeDirectory = await tempHome();
    const handle = configureLogging({ homeDirectory, instanceId: 'instance_fixed' });
    const logger = getLogger('runtime.orchestrator');
    logger.info('turn.completed', { fields: { status: 'final', durationMs: 1 } });
    getLogger('dynamic.component').info('private-event-name', {
      fields: { status: 'private-value' },
    });
    await handle.close();

    const agent = await records(join(homeDirectory, 'logs', 'agent.log'));
    expect(agent.every(({ resource }) => resource['service.instance.id'] === 'instance_fixed')).toBe(true);
    expect(agent[1]).toMatchObject({
      eventName: 'logging.event.invalid',
      attributes: {
        'logging.component': 'dynamic.component',
        'logging.validation.category': 'unknown_event',
      },
    });
    expect(JSON.stringify(agent[1])).not.toContain('private-event-name');
    expect(JSON.stringify(agent[1])).not.toContain('private-value');
  });

  it('enables byte-equivalent stdout only for gateway mode', async () => {
    const homeDirectory = await tempHome();
    const stdout = { write: vi.fn() };
    const handle = configureLogging({
      homeDirectory,
      mode: 'gateway',
      environment: { NODE_ENV: 'test', PLUS_ONE_LOG_STDOUT: 'true' },
      stdout,
    });
    getLogger('engine.gateway').info('runtime.started', {
      fields: { mode: 'gateway' },
    });
    await handle.close();

    const fileLine = await readFile(join(homeDirectory, 'logs', 'agent.log'), 'utf8');
    expect(stdout.write).toHaveBeenCalledExactlyOnceWith(fileLine);

    const cliStdout = { write: vi.fn() };
    const cliHandle = configureLogging({
      homeDirectory: await tempHome(),
      mode: 'cli',
      environment: { NODE_ENV: 'test', PLUS_ONE_LOG_STDOUT: 'true' },
      stdout: cliStdout,
    });
    getLogger('runtime.orchestrator').info('turn.completed', {
      fields: { status: 'final', durationMs: 1 },
    });
    await cliHandle.close();
    expect(cliStdout.write).not.toHaveBeenCalled();
  });

  it('provides a real flush barrier and serializes reconfiguration ownership', async () => {
    const writes: string[] = [];
    let releaseWrite: (() => void) | undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const firstSink: LogSink = {
      name: 'first',
      matches: () => true,
      write: vi.fn(async (record) => {
        await writeGate;
        writes.push(`first:${record.eventName}`);
      }),
      close: vi.fn(async () => {
        writes.push('first:closed');
      }),
    };
    const first = configureLogging({
      homeDirectory: await tempHome(),
      sinks: [firstSink],
    });
    getLogger('runtime.orchestrator').info('turn.completed', {
      fields: { status: 'first', durationMs: 1 },
    });
    let flushed = false;
    void first.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);

    const secondSink: LogSink = {
      name: 'second',
      matches: () => true,
      write: vi.fn(async (record) => {
        writes.push(`second:${record.eventName}`);
      }),
      close: vi.fn(async () => undefined),
    };
    const second = configureLogging({
      homeDirectory: await tempHome(),
      sinks: [secondSink],
    });
    getLogger('runtime.orchestrator').info('turn.completed', {
      fields: { status: 'second', durationMs: 1 },
    });
    await Promise.resolve();
    expect(writes).toEqual([]);
    releaseWrite?.();
    await first.close();
    await second.close();

    expect(writes).toEqual([
      'first:turn.completed',
      'first:closed',
      'second:turn.completed',
    ]);
  });

  it('falls back safely when the log directory cannot be created', async () => {
    const stderr = { write: vi.fn() };
    const handle = configureLogging({ homeDirectory: '/dev/null', stderr });
    expect(() => getLogger('runtime.orchestrator').warn('orchestrator.response.withheld', {
      fields: { matchCategory: 'unsafe' },
    })).not.toThrow();
    await handle.close();
    expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining('logging.sink.failed'));
  });
});
