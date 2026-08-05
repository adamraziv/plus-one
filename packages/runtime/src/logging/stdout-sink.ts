import { serializeLogEnvelope } from './ndjson.js';
import type { LogEnvelopeV1, LogSink } from './types.js';

export class NdjsonStdoutSink implements LogSink {
  readonly name: string;
  private closed = false;

  constructor(private readonly options: {
    name: string;
    output: { write(text: string): void };
    matches(record: LogEnvelopeV1): boolean;
  }) {
    this.name = options.name;
  }

  matches(record: LogEnvelopeV1): boolean {
    return this.options.matches(record);
  }

  async write(record: LogEnvelopeV1): Promise<void> {
    if (this.closed) return;
    this.options.output.write(serializeLogEnvelope(record));
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
