import {
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { followLog, readLogTail } from './log-reader.js';
import { serializeLogEnvelope } from './ndjson.js';
import type { LogEnvelopeV1 } from './types.js';

function envelope(
  eventName: string,
  input: {
    timestamp?: string;
    severity?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
    component?: string;
    attributes?: Readonly<Record<string, string | number | boolean>>;
  } = {},
): LogEnvelopeV1 {
  const severityText = input.severity ?? 'INFO';
  const severityNumber = { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 } as const;
  return {
    schemaVersion: 1,
    timestamp: input.timestamp ?? '2026-07-28T10:00:00.000Z',
    observedTimestamp: input.timestamp ?? '2026-07-28T10:00:00.001Z',
    severityText,
    severityNumber: severityNumber[severityText],
    eventName,
    body: eventName,
    resource: { 'service.name': 'plus-one' },
    instrumentationScope: { name: input.component ?? 'runtime.orchestrator' },
    attributes: input.attributes ?? {},
  };
}

async function homeWithLogs(): Promise<string> {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-log-reader-'));
  await mkdir(join(homeDirectory, 'logs'));
  return homeDirectory;
}

describe('log reader', () => {
  it('reads active, rotated, migrated, partial, and rollback sources in stable order', async () => {
    const homeDirectory = await homeWithLogs();
    const logs = join(homeDirectory, 'logs');
    await writeFile(join(logs, 'agent.log.2'), serializeLogEnvelope(envelope('rotated.old', {
      timestamp: '2026-07-28T10:00:00.000Z',
    })));
    await writeFile(join(logs, 'agent.log.1'), serializeLogEnvelope(envelope('rotated.new', {
      timestamp: '2026-07-28T10:00:00.000Z',
    })));
    await writeFile(join(logs, 'agent.log.legacy-2026'), [
      '2026-07-28 10:00:01.000 WARNING [requestId=req_legacy taskId=task_legacy] runtime.delivery: delivery.failed status=failed token=secret-value',
      '',
    ].join('\n'));
    await writeFile(join(logs, 'agent.log.mixed-2026'), [
      serializeLogEnvelope(envelope('mixed.ndjson', { timestamp: '2026-07-28T10:00:02.000Z' })).trim(),
      '2026-07-28 10:00:03.000 INFO runtime.agent: agent.completed status=ok',
      '',
    ].join('\n'));
    await writeFile(join(logs, 'agent.log.partial-2026'), [
      serializeLogEnvelope(envelope('partial.valid', { timestamp: '2026-07-28T10:00:04.000Z' })).trim(),
      '{"schemaVersion":1',
    ].join('\n'));
    await writeFile(join(logs, 'agent.log'), serializeLogEnvelope(envelope('active', {
      timestamp: '2026-07-28T10:00:05.000Z',
    })));
    const rollback = join(homeDirectory, 'logs.rollback-20260727');
    await mkdir(rollback);
    await writeFile(join(rollback, 'agent.log'), serializeLogEnvelope(envelope('rollback', {
      timestamp: '2026-07-27T10:00:00.000Z',
    })));
    const diagnostics = { write: vi.fn() };

    const records = await readLogTail({
      homeDirectory,
      log: 'agent',
      lines: 50,
      diagnostics,
    });

    expect(records.map(({ envelope: record }) => record.eventName)).toEqual([
      'rollback',
      'rotated.old',
      'rotated.new',
      'legacy.record',
      'mixed.ndjson',
      'legacy.record',
      'partial.valid',
      'active',
    ]);
    const legacy = records.find(({ source }) => source.format === 'legacy');
    expect(legacy?.envelope).toMatchObject({
      severityText: 'WARN',
      severityNumber: 13,
      eventName: 'legacy.record',
      body: 'legacy.record',
      instrumentationScope: { name: 'runtime.delivery' },
      attributes: {
        'request.id': 'req_legacy',
        'plus_one.task.id': 'task_legacy',
        'legacy.event.name': 'delivery.failed',
        'log.source.format': 'legacy',
      },
    });
    expect(JSON.stringify(legacy?.envelope)).not.toContain('secret-value');
    expect(diagnostics.write).toHaveBeenCalledWith(expect.stringContaining('malformed'));
  });

  it('applies all filters before the final lines cap', async () => {
    const homeDirectory = await homeWithLogs();
    const path = join(homeDirectory, 'logs', 'agent.log');
    const rows = [
      envelope('working_memory.write.failed', {
        timestamp: '2026-07-28T10:00:00.000Z',
        severity: 'ERROR',
        component: 'runtime.memory',
        attributes: {
          'request.id': 'req_1',
          'plus_one.conversation.id': 'conv_1',
          'plus_one.household.id': 'household_1',
          'plus_one.task.id': 'task_1',
          'plus_one.run.id': 'run_1',
          'plus_one.delivery.id': 'delivery_1',
        },
      }),
      envelope('working_memory.review.completed', {
        timestamp: '2026-07-28T10:01:00.000Z',
        component: 'runtime.memory',
        attributes: { 'request.id': 'req_1' },
      }),
      envelope('working_memory.read.failed', {
        timestamp: '2026-07-28T10:02:00.000Z',
        severity: 'ERROR',
        component: 'runtime.memory',
        attributes: {
          'request.id': 'req_1',
          'plus_one.conversation.id': 'conv_1',
          'plus_one.household.id': 'household_1',
          'plus_one.task.id': 'task_1',
          'plus_one.run.id': 'run_1',
          'plus_one.delivery.id': 'delivery_1',
        },
      }),
    ];
    await writeFile(path, rows.map(serializeLogEnvelope).join(''));

    const records = await readLogTail({
      homeDirectory,
      log: 'agent',
      lines: 1,
      minLevel: 'WARN',
      correlations: {
        requestId: 'req_1',
        conversationId: 'conv_1',
        householdId: 'household_1',
        taskId: 'task_1',
        runId: 'run_1',
        deliveryId: 'delivery_1',
      },
      component: 'runtime.memory',
      event: 'working_memory.',
      since: new Date('2026-07-28T09:59:00.000Z'),
    });

    expect(records.map(({ envelope: record }) => record.eventName)).toEqual([
      'working_memory.read.failed',
    ]);
  });

  it('merges gateway and launcher files and returns an empty result when no source exists', async () => {
    const homeDirectory = await homeWithLogs();
    await writeFile(join(homeDirectory, 'logs', 'gateway.log'), serializeLogEnvelope(envelope(
      'runtime.started',
      { component: 'engine.gateway', timestamp: '2026-07-28T10:01:00.000Z' },
    )));
    await writeFile(join(homeDirectory, 'logs', 'launcher.log'), serializeLogEnvelope(envelope(
      'launcher.started',
      { component: 'engine.gateway.launcher', timestamp: '2026-07-28T10:00:00.000Z' },
    )));

    expect((await readLogTail({ homeDirectory, log: 'gateway' }))
      .map(({ envelope: record }) => record.eventName)).toEqual([
      'launcher.started',
      'runtime.started',
    ]);
    expect(await readLogTail({ homeDirectory, log: 'errors' })).toEqual([]);
  });

  it('follows an initially missing file, replacement, and rotation until aborted', async () => {
    const homeDirectory = await homeWithLogs();
    const path = join(homeDirectory, 'logs', 'agent.log');
    const controller = new AbortController();
    const observed: string[] = [];
    const following = followLog(
      { homeDirectory, log: 'agent' },
      (record) => observed.push(record.envelope.eventName),
      controller.signal,
    );

    await new Promise((resolve) => setTimeout(resolve, 120));
    await writeFile(path, serializeLogEnvelope(envelope('created')));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await appendFile(path, serializeLogEnvelope(envelope('appended')));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rename(path, `${path}.1`);
    await writeFile(path, serializeLogEnvelope(envelope('rotated.active')));
    await new Promise((resolve) => setTimeout(resolve, 180));
    controller.abort();
    await following;

    expect(observed).toEqual(['created', 'appended', 'rotated.active']);
  });
});
