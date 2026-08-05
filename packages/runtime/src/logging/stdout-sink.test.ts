import { describe, expect, it, vi } from 'vitest';
import { serializeLogEnvelope } from './ndjson.js';
import { NdjsonStdoutSink } from './stdout-sink.js';
import type { LogEnvelopeV1 } from './types.js';

const ENVELOPE: LogEnvelopeV1 = {
  schemaVersion: 1,
  timestamp: '2026-07-28T10:15:30.123Z',
  observedTimestamp: '2026-07-28T10:15:30.124Z',
  severityText: 'INFO',
  severityNumber: 9,
  eventName: 'runtime.started',
  body: 'runtime.started',
  resource: { 'service.name': 'plus-one' },
  instrumentationScope: { name: 'engine.gateway' },
  attributes: { 'runtime.mode': 'gateway' },
};

describe('NdjsonStdoutSink', () => {
  it('writes the byte-identical canonical line once per envelope', async () => {
    const output = { write: vi.fn() };
    const sink = new NdjsonStdoutSink({
      name: 'stdout',
      output,
      matches: () => true,
    });
    await sink.write(ENVELOPE);
    await sink.close();
    expect(output.write).toHaveBeenCalledExactlyOnceWith(serializeLogEnvelope(ENVELOPE));
  });
});
