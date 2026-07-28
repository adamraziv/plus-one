import { sanitizeLogString } from './redaction.js';
import type { ReadableLogRecord } from './types.js';

const HIDDEN_DEFAULT_ATTRIBUTES = new Set(['exception.stacktrace']);

export function formatReadableLogRecord(
  record: ReadableLogRecord,
  options: { stack?: boolean } = {},
): string {
  const { envelope } = record;
  const attributes = Object.entries(envelope.attributes)
    .filter(([key]) => !HIDDEN_DEFAULT_ATTRIBUTES.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${token(value)}`);
  if (record.legacyDisplayMessage !== undefined) {
    attributes.push(`legacy.message=${token(record.legacyDisplayMessage)}`);
  }
  const base = [
    envelope.timestamp,
    envelope.severityText,
    `${envelope.instrumentationScope.name}:`,
    envelope.eventName,
    ...attributes,
  ].join(' ');
  const stack = options.stack
    ? envelope.attributes['exception.stacktrace']
    : undefined;
  return `${base}${typeof stack === 'string' ? ` stack=${token(stack)}` : ''}\n`;
}

function token(value: string | number | boolean): string {
  return typeof value === 'string'
    ? sanitizeLogString(value).replace(/\s+/g, '_')
    : String(value);
}
