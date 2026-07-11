import { redactSecrets } from './redaction.js';
import type { LogContextKey, LogRecord } from './types.js';

const CONTEXT_KEYS: readonly LogContextKey[] = [
  'requestId', 'conversationId', 'householdId', 'taskId', 'runId', 'deliveryId',
];

export function formatLogRecord(record: LogRecord): string {
  const timestamp = record.timestamp.toISOString().replace('T', ' ').replace('Z', '');
  const context = CONTEXT_KEYS
    .flatMap((key) => {
      const value = record.context[key];
      return value === undefined ? [] : [`${key}=${token(value)}`];
    })
    .join(' ');
  const fields = Object.entries(record.fields)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${token(String(value))}`)
    .join(' ');
  const error = record.error === undefined
    ? ''
    : ` error=${token(record.error.name)}:${token(record.error.message)}`;
  const suffix = [fields, error.trim()].filter((part) => part.length > 0).join(' ');
  return `${timestamp} ${record.level}${context.length === 0 ? '' : ` [${context}]`} ${record.component}: ${record.event}${suffix.length === 0 ? '' : ` ${suffix}`}\n`;
}

function token(value: string): string {
  return redactSecrets(value).replace(/[\r\n\t ]+/g, '_');
}
