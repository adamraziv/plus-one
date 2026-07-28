import { describe, expect, it, vi } from 'vitest';
import type { ReadableLogRecord } from '@plus-one/runtime';
import { runLogsCli } from '../src/logs-cli.js';

function readable(eventName = 'turn.completed'): ReadableLogRecord {
  return {
    envelope: {
      schemaVersion: 1,
      timestamp: '2026-07-28T10:15:30.123Z',
      observedTimestamp: '2026-07-28T10:15:30.124Z',
      severityText: 'INFO',
      severityNumber: 9,
      eventName,
      body: eventName,
      resource: { 'service.name': 'plus-one' },
      instrumentationScope: { name: 'runtime.orchestrator' },
      attributes: {},
    },
    source: {
      path: '/tmp/agent.log',
      format: 'ndjson',
      generation: 0,
      byteOffset: 0,
    },
  };
}

describe('plus-one logs CLI', () => {
  it('implements the no-argument alias with human output', async () => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const readLogTail = vi.fn(async () => [readable()]);
    await expect(runLogsCli([], {
      environment: { PLUS_ONE_HOME: '/tmp/plus-one' },
      stdout,
      stderr,
      readLogTail,
    })).resolves.toBe(0);

    expect(readLogTail).toHaveBeenCalledWith(expect.objectContaining({
      homeDirectory: '/tmp/plus-one',
      log: 'agent',
      lines: 50,
      diagnostics: stderr,
    }));
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining('turn.completed'));
  });

  it('combines every filter and normalizes WARNING to WARN', async () => {
    const stderr = { write: vi.fn() };
    const readLogTail = vi.fn(async () => []);
    await expect(runLogsCli([
      'gateway',
      '--level', 'WARNING',
      '--event', 'gateway.turn.',
      '--component', 'gateway',
      '--request', 'req_1',
      '--conversation', 'conv_1',
      '--household', 'household_1',
      '--task', 'task_1',
      '--run', 'run_1',
      '--delivery', 'delivery_1',
      '--since', '1h',
      '--lines', '10',
      '--json',
    ], {
      environment: { PLUS_ONE_HOME: '/tmp/plus-one' },
      stdout: { write: vi.fn() },
      stderr,
      readLogTail,
    })).resolves.toBe(0);

    expect(readLogTail).toHaveBeenCalledWith(expect.objectContaining({
      log: 'gateway',
      lines: 10,
      minLevel: 'WARN',
      component: 'gateway',
      event: 'gateway.turn.',
      correlations: {
        requestId: 'req_1',
        conversationId: 'conv_1',
        householdId: 'household_1',
        taskId: 'task_1',
        runId: 'run_1',
        deliveryId: 'delivery_1',
      },
      since: expect.any(Date),
      diagnostics: stderr,
    }));
  });

  it('emits canonical NDJSON in --json and --json --follow modes', async () => {
    const stdout = { write: vi.fn() };
    const followLog = vi.fn(async (_query, onRecord: (record: ReadableLogRecord) => void) => {
      onRecord(readable('turn.failed'));
    });
    await expect(runLogsCli(['--json', '--follow'], {
      environment: {},
      stdout,
      stderr: { write: vi.fn() },
      readLogTail: vi.fn(async () => [readable()]),
      followLog,
    })).resolves.toBe(0);

    const output = stdout.write.mock.calls.map(([line]) => line).join('');
    expect(output.trim().split('\n').map((line) => JSON.parse(line).eventName)).toEqual([
      'turn.completed',
      'turn.failed',
    ]);
  });

  it('supports human stack rendering and rejects --json --stack', async () => {
    const record = readable('turn.failed');
    record.envelope.severityText = 'ERROR';
    record.envelope.severityNumber = 17;
    record.envelope.attributes = {
      ...record.envelope.attributes,
      'exception.stacktrace': 'SafeError frame_one',
    };
    const stdout = { write: vi.fn() };
    await expect(runLogsCli(['--stack'], {
      environment: {},
      stdout,
      stderr: { write: vi.fn() },
      readLogTail: vi.fn(async () => [record]),
    })).resolves.toBe(0);
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining('frame_one'));

    const stderr = { write: vi.fn() };
    await expect(runLogsCli(['--json', '--stack'], {
      environment: {},
      stdout: { write: vi.fn() },
      stderr,
      readLogTail: vi.fn(),
    })).resolves.toBe(1);
    expect(stderr.write).toHaveBeenCalledTimes(1);
  });

  it('handles missing files, waiting follow, and Ctrl-C as success', async () => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    await expect(runLogsCli([], {
      environment: {},
      stdout,
      stderr,
      readLogTail: vi.fn(async () => []),
    })).resolves.toBe(0);
    expect(stdout.write).toHaveBeenCalledWith('No logs yet.\n');

    const followLog = vi.fn(async (_query, _onRecord, signal: AbortSignal) => {
      process.emit('SIGINT');
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    await expect(runLogsCli(['--follow'], {
      environment: {},
      stdout: { write: vi.fn() },
      stderr,
      readLogTail: vi.fn(async () => []),
      followLog,
    })).resolves.toBe(0);
    expect(stderr.write).toHaveBeenCalledWith('Waiting for logs...\n');
  });

  it.each([
    ['unknown stream', ['unknown']],
    ['unknown flag', ['--unknown', 'value']],
    ['bad level', ['--level', 'NOPE']],
    ['bad since', ['--since', 'later']],
    ['bad lines', ['--lines', '0']],
    ['missing value', ['--event']],
  ])('returns one concise usage error for %s', async (_label, argv) => {
    const stderr = { write: vi.fn() };
    const readLogTail = vi.fn();
    await expect(runLogsCli(argv, {
      environment: {},
      stdout: { write: vi.fn() },
      stderr,
      readLogTail,
    })).resolves.toBe(1);
    expect(readLogTail).not.toHaveBeenCalled();
    expect(stderr.write).toHaveBeenCalledTimes(1);
    expect(stderr.write).toHaveBeenCalledWith(expect.stringMatching(/^Usage error: .+\n$/));
  });
});
