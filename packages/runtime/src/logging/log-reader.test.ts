import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { followLog, readLogTail } from './log-reader.js';

async function seededHome(): Promise<string> {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-log-reader-'));
  await mkdir(join(homeDirectory, 'logs'));
  await writeFile(join(homeDirectory, 'logs', 'agent.log'), [
    '2026-07-12 10:00:00.000 INFO [requestId=req_1 taskId=task_1] gateway.channel: gateway.inbound.accepted channel=telegram\n',
    '2026-07-12 10:01:00.000 WARNING [requestId=req_1 taskId=task_1] runtime.delivery: delivery.failed status=failed\n',
    '2026-07-12 10:02:00.000 ERROR [requestId=req_2 taskId=task_2] runtime.agent: agent.failed status=failed\n',
  ].join(''));
  return homeDirectory;
}

describe('log reader', () => {
  it('returns the requested tail', async () => {
    const homeDirectory = await seededHome();
    expect(readLogTail({ homeDirectory, log: 'agent', lines: 2 })).toHaveLength(2);
  });

  it('filters by level, correlation, component, and relative time', async () => {
    const homeDirectory = await seededHome();
    expect(readLogTail({ homeDirectory, log: 'agent', minLevel: 'ERROR' })).toEqual([
      expect.stringContaining('agent.failed'),
    ]);
    expect(readLogTail({
      homeDirectory,
      log: 'agent',
      correlation: { key: 'taskId', value: 'task_1' },
    })).toHaveLength(2);
    expect(readLogTail({ homeDirectory, log: 'agent', component: 'gateway' })).toEqual([
      expect.stringContaining('gateway.inbound.accepted'),
    ]);
    expect(readLogTail({
      homeDirectory,
      log: 'agent',
      since: new Date('2026-07-12T10:01:00.000Z'),
    })).toHaveLength(2);
  });

  it('rejects unknown logs and missing files with concise errors', async () => {
    const homeDirectory = await seededHome();
    expect(() => readLogTail({ homeDirectory, log: 'unknown' as never })).toThrow('Unknown log');
    expect(() => readLogTail({ homeDirectory, log: 'errors' })).toThrow('Log file not found');
  });

  it('follows new matching lines until aborted', async () => {
    const homeDirectory = await seededHome();
    const output = { write: vi.fn() };
    const controller = new AbortController();
    const following = followLog({ homeDirectory, log: 'agent', component: 'gateway' }, output, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await appendFile(join(homeDirectory, 'logs', 'agent.log'),
      '2026-07-12 10:03:00.000 INFO [requestId=req_3] gateway.channel: gateway.inbound.accepted channel=telegram\n');
    await new Promise((resolve) => setTimeout(resolve, 350));
    controller.abort();
    await following;
    expect(output.write).toHaveBeenCalledWith(expect.stringContaining('gateway.inbound.accepted'));
  });
});
