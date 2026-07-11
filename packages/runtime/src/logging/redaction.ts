import type { LogFields } from './types.js';

const SENSITIVE_FIELD_NAMES = new Set([
  'body', 'content', 'prompt', 'response', 'payload', 'amount', 'description',
  'account', 'attachments', 'metadata', 'arguments', 'result', 'artifact',
  'sql', 'query', 'connectionstring', 'connection_string', 'token', 'secret',
  'password', 'apikey', 'authorization', 'privatekey', 'pairingcode', 'codehash',
]);

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/(Authorization:\s*(?:[A-Za-z][\w.+-]*\s+)?)([^\s"']+)/gi, '$1***'],
  [/(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/([^:\s]+:)([^@\s]+)(@)/gi, '$1***$3'],
  [/(\b(?:api[_-]?key|token|password|secret)\s*[=:]\s*)([^\s,;]+)/gi, '$1***'],
  [/(\b(?:sk-|ghp_|github_pat_|xox[baprs]-|AIza|bot\d{8,}:))([A-Za-z0-9_.:/_-]{10,})/g, '$1***'],
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    value,
  );
}

export function sanitizeFields(fields: LogFields | undefined): LogFields {
  if (fields === undefined) return {};
  const sanitized: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_FIELD_NAMES.has(key.toLowerCase()) || value === undefined) continue;
    sanitized[key] = typeof value === 'string' ? redactSecrets(value).slice(0, 1_000) : value;
  }
  return sanitized;
}

export function serializeLogError(error: unknown): {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  category?: string;
} {
  const candidate = error !== null && typeof error === 'object' ? error as Record<string, unknown> : undefined;
  const name = error instanceof Error ? error.name : stringProperty(candidate, 'name') ?? 'UnknownError';
  const rawMessage = error instanceof Error ? error.message : stringProperty(candidate, 'message') ?? String(error);
  const rawStack = error instanceof Error ? error.stack : stringProperty(candidate, 'stack');
  const output: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
    category?: string;
  } = {
    name: redactSecrets(name).slice(0, 200),
    message: redactSecrets(rawMessage).slice(0, 1_000),
  };
  const stack = rawStack === undefined ? undefined : redactSecrets(rawStack).slice(0, 1_000);
  const code = stringProperty(candidate, 'code');
  const category = stringProperty(candidate, 'category');
  if (stack !== undefined) output.stack = stack;
  if (code !== undefined) output.code = redactSecrets(code).slice(0, 200);
  if (category !== undefined) output.category = redactSecrets(category).slice(0, 200);
  return output;
}

function stringProperty(candidate: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = candidate?.[key];
  return typeof value === 'string' ? value : undefined;
}
