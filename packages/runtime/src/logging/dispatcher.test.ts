import { describe, expect, it, vi } from 'vitest';
import { LogDispatcher } from './dispatcher.js';
import type { LogEnvelopeV1, LogSeverityText, LogSink } from './types.js';

function record(severityText: LogSeverityText, eventName: string): LogEnvelopeV1 {
  const severityNumber = { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 } as const;
  return {
    schemaVersion: 1,
    timestamp: '2026-07-28T10:15:30.123Z',
    observedTimestamp: '2026-07-28T10:15:30.124Z',
    severityText,
    severityNumber: severityNumber[severityText],
    eventName,
    body: eventName,
    resource: { 'service.name': 'plus-one' },
    instrumentationScope: { name: 'runtime.test' },
    attributes: {},
  };
}

function memorySink(
  name: string,
  writes: LogEnvelopeV1[],
  write?: (record: LogEnvelopeV1) => Promise<void>,
): LogSink {
  return {
    name,
    matches: () => true,
    write: vi.fn(write ?? (async (entry) => {
      writes.push(entry);
    })),
    close: vi.fn(async () => undefined),
  };
}

describe('LogDispatcher', () => {
  it('preserves FIFO order and applies deterministic severity displacement', async () => {
    const writes: LogEnvelopeV1[] = [];
    const stderr = { write: vi.fn() };
    const dispatcher = new LogDispatcher({
      sinks: [memorySink('memory', writes)],
      capacity: 2,
      stderr,
    });

    dispatcher.dispatch(record('DEBUG', 'orchestrator.step.completed'));
    dispatcher.dispatch(record('INFO', 'turn.started'));
    dispatcher.dispatch(record('ERROR', 'turn.failed'));
    await dispatcher.flush();

    expect(writes.map(({ eventName }) => eventName)).toEqual([
      'turn.started',
      'turn.failed',
      'logging.records.dropped',
    ]);
    expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining('logging.records.dropped'));
  });

  it('uses an exact default capacity of 4,096 records', async () => {
    let releaseStart: (() => void) | undefined;
    const startAfter = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const writes: LogEnvelopeV1[] = [];
    const dispatcher = new LogDispatcher({
      sinks: [memorySink('memory', writes)],
      stderr: { write: vi.fn() },
      startAfter,
    });

    for (let index = 0; index < 4_097; index += 1) {
      dispatcher.dispatch(record('INFO', `test.event.${index}`));
    }
    releaseStart?.();
    await dispatcher.flush();

    expect(writes.filter(({ eventName }) => eventName.startsWith('test.event.'))).toHaveLength(4_096);
  });

  it('isolates sink failures, marks a failed record terminal, and recovers later', async () => {
    const healthyWrites: LogEnvelopeV1[] = [];
    const recoveringWrites: LogEnvelopeV1[] = [];
    let attempt = 0;
    const recovering = memorySink('recovering', recoveringWrites, async (entry) => {
      attempt += 1;
      if (attempt === 1) throw new Error('Authorization: Bearer secret-value');
      recoveringWrites.push(entry);
    });
    const stderr = { write: vi.fn() };
    const dispatcher = new LogDispatcher({
      sinks: [recovering, memorySink('healthy', healthyWrites)],
      stderr,
      now: () => 1,
    });

    dispatcher.dispatch(record('INFO', 'turn.started'));
    await dispatcher.flush();
    dispatcher.dispatch(record('INFO', 'turn.completed'));
    await dispatcher.flush();

    expect(recoveringWrites.filter(({ eventName }) => eventName === 'turn.started')).toHaveLength(0);
    expect(recoveringWrites.filter(({ eventName }) => eventName === 'turn.completed')).toHaveLength(1);
    expect(healthyWrites.map(({ eventName }) => eventName)).toEqual(expect.arrayContaining([
      'turn.started',
      'turn.completed',
      'logging.sink.failed',
      'logging.sink.recovered',
    ]));
    expect(JSON.stringify(stderr.write.mock.calls)).not.toContain('secret-value');
  });

  it('honors flush sequence barriers and closes idempotently', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const writes: LogEnvelopeV1[] = [];
    const sink = memorySink('memory', writes, async (entry) => {
      if (entry.eventName === 'first') await firstGate;
      writes.push(entry);
    });
    const dispatcher = new LogDispatcher({ sinks: [sink], stderr: { write: vi.fn() } });

    dispatcher.dispatch(record('INFO', 'first'));
    const barrier = dispatcher.flush();
    dispatcher.dispatch(record('INFO', 'second'));
    let barrierResolved = false;
    void barrier.then(() => {
      barrierResolved = true;
    });
    await Promise.resolve();
    expect(barrierResolved).toBe(false);
    releaseFirst?.();
    await barrier;
    await dispatcher.close();
    await dispatcher.close();

    expect(writes.map(({ eventName }) => eventName)).toEqual(['first', 'second']);
    expect(sink.close).toHaveBeenCalledOnce();
  });

  it('writes a final direct drop summary when closing a saturated queue', async () => {
    let releaseStart: (() => void) | undefined;
    const startAfter = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const stderr = { write: vi.fn() };
    const dispatcher = new LogDispatcher({
      sinks: [memorySink('memory', [])],
      capacity: 1,
      stderr,
      startAfter,
    });
    dispatcher.dispatch(record('ERROR', 'first'));
    dispatcher.dispatch(record('ERROR', 'second'));
    releaseStart?.();
    await dispatcher.close();

    expect(stderr.write).toHaveBeenLastCalledWith(expect.stringContaining('logging.records.dropped'));
  });

  it('reports sink close failures directly without rejecting or leaking the failure', async () => {
    const sink = memorySink('closing-sink', []);
    sink.close = vi.fn(async () => {
      throw new Error('Authorization: Bearer secret-value');
    });
    const stderr = { write: vi.fn() };
    const dispatcher = new LogDispatcher({ sinks: [sink], stderr });

    await expect(dispatcher.close()).resolves.toBeUndefined();
    await expect(dispatcher.close()).resolves.toBeUndefined();

    expect(sink.close).toHaveBeenCalledOnce();
    expect(stderr.write).toHaveBeenCalledExactlyOnceWith(
      'ERROR logging.sink.failed sink=closing-sink category=close_failed\n',
    );
    expect(JSON.stringify(stderr.write.mock.calls)).not.toContain('secret-value');
  });
});
