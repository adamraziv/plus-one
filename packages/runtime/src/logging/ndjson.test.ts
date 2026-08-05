import { describe, expect, it } from 'vitest';
import { parseLogEnvelope, serializeLogEnvelope } from './ndjson.js';
import type { LogEnvelopeV1 } from './types.js';

const ENVELOPE: LogEnvelopeV1 = {
  schemaVersion: 1,
  timestamp: '2026-07-28T10:15:30.123Z',
  observedTimestamp: '2026-07-28T10:15:30.124Z',
  severityText: 'WARN',
  severityNumber: 13,
  eventName: 'delivery.ambiguous',
  body: 'delivery.ambiguous',
  resource: {
    'service.name': 'plus-one',
    'service.instance.id': 'instance_1',
    'deployment.environment.name': 'test',
  },
  instrumentationScope: { name: 'runtime.delivery' },
  attributes: {
    channel: 'telegram',
    status: 'ambiguous',
    'duration.ms': 12,
  },
};

describe('canonical logging NDJSON', () => {
  it('serializes one compact physical line and round-trips', () => {
    const line = serializeLogEnvelope(ENVELOPE);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    expect(parseLogEnvelope(line.trim())).toEqual(ENVELOPE);
  });

  it('rejects malformed, nested, mismatched, and extra-field input', () => {
    expect(parseLogEnvelope('not-json')).toBeUndefined();
    expect(parseLogEnvelope(JSON.stringify({
      ...ENVELOPE,
      severityNumber: 17,
    }))).toBeUndefined();
    expect(parseLogEnvelope(JSON.stringify({
      ...ENVELOPE,
      attributes: { nested: { private: true } },
    }))).toBeUndefined();
    expect(parseLogEnvelope(JSON.stringify({
      ...ENVELOPE,
      privateField: 'not allowed',
    }))).toBeUndefined();
  });
});
