import { describe, expect, it, vi } from 'vitest';
import { runLogsCli } from '../src/logs-cli.js';

describe('plus-one logs CLI', () => {
  it('prints the last agent records by default', async () => {
    const write = vi.fn();
    const readLogTail = vi.fn(() => ['line one\n', 'line two\n']);
    await expect(runLogsCli([], {
      environment: { PLUS_ONE_HOME: '/tmp/plus-one' },
      stdout: { write },
      stderr: { write: vi.fn() },
      readLogTail,
    })).resolves.toBe(0);
    expect(readLogTail).toHaveBeenCalledWith(expect.objectContaining({ log: 'agent', lines: 50 }));
    expect(write).toHaveBeenCalledWith('line one\n');
    expect(write).toHaveBeenCalledWith('line two\n');
  });

  it('parses level, task, component, and since filters', async () => {
    const readLogTail = vi.fn(() => []);
    await expect(runLogsCli([
      'gateway', '--level', 'ERROR', '--task', 'task_1', '--component', 'gateway', '--since', '1h', '--lines', '10',
    ], {
      environment: { PLUS_ONE_HOME: '/tmp/plus-one' },
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      readLogTail,
    })).resolves.toBe(0);
    expect(readLogTail).toHaveBeenCalledWith(expect.objectContaining({
      log: 'gateway', lines: 10, minLevel: 'ERROR',
      correlation: { key: 'taskId', value: 'task_1' }, component: 'gateway', since: expect.any(Date),
    }));
  });

  it('rejects an unknown level without reading a file', async () => {
    const stderr = { write: vi.fn() };
    const readLogTail = vi.fn();
    await expect(runLogsCli(['--level', 'NOPE'], {
      environment: {}, stdout: { write: vi.fn() }, stderr, readLogTail,
    })).resolves.toBe(1);
    expect(readLogTail).not.toHaveBeenCalled();
    expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining('DEBUG, INFO, WARNING, or ERROR'));
  });

  it('returns a clean result after follow mode is aborted', async () => {
    const followLog = vi.fn(async (_query, _output, signal: AbortSignal) => {
      signal.dispatchEvent(new Event('abort'));
    });
    await expect(runLogsCli(['gateway', '--follow'], {
      environment: {}, stdout: { write: vi.fn() }, stderr: { write: vi.fn() }, followLog,
    })).resolves.toBe(0);
    expect(followLog).toHaveBeenCalledWith(expect.objectContaining({ log: 'gateway' }), expect.any(Object), expect.any(AbortSignal));
  });
});
