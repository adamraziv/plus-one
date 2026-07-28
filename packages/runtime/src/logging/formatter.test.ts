import { describe, expect, it } from 'vitest';
import { formatReadableLogRecord } from './formatter.js';
import type { ReadableLogRecord } from './types.js';

function readable(): ReadableLogRecord {
  return {
    envelope: {
      schemaVersion: 1,
      timestamp: '2026-07-28T10:15:30.123Z',
      observedTimestamp: '2026-07-28T10:15:30.124Z',
      severityText: 'ERROR',
      severityNumber: 17,
      eventName: 'turn.failed',
      body: 'turn.failed',
      resource: { 'service.name': 'plus-one' },
      instrumentationScope: { name: 'runtime.orchestrator' },
      attributes: {
        'request.id': 'req_1',
        'failure.category': 'model_unavailable',
        'exception.stacktrace': 'SafeError: unavailable frame_one frame_two',
      },
    },
    source: {
      path: '/tmp/agent.log',
      format: 'ndjson',
      generation: 0,
      byteOffset: 0,
    },
  };
}

describe('formatReadableLogRecord', () => {
  it('renders one concise human line without the stack by default', () => {
    const output = formatReadableLogRecord(readable());
    expect(output).toContain('ERROR runtime.orchestrator: turn.failed');
    expect(output).toContain('request.id=req_1');
    expect(output).toContain('failure.category=model_unavailable');
    expect(output).not.toContain('frame_one');
    expect(output.endsWith('\n')).toBe(true);
  });

  it('adds the sanitized recorded stack only when requested', () => {
    expect(formatReadableLogRecord(readable(), { stack: true })).toContain('frame_one');
  });

  it('renders only the sanitized bounded display copy of unknown legacy text', () => {
    const record = readable();
    record.envelope.eventName = 'legacy.record';
    record.envelope.body = 'legacy.record';
    record.legacyDisplayMessage = 'unknown token=secret-value\r\nmessage';
    const output = formatReadableLogRecord(record);
    expect(output).toContain('legacy.record');
    expect(output).not.toContain('secret-value');
    expect(output.match(/\n/g)).toHaveLength(1);
  });
});
