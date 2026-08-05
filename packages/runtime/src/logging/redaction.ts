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
  [/(\b(?:api[_-]?key|token|password|secret)\b["']?\s*[=:]\s*["']?)([^\s,;}"']+)/gi, '$1***'],
  [/(\b(?:sk-|ghp_|github_pat_|xox[baprs]-|AIza|bot\d{8,}:))([A-Za-z0-9_.:/_-]{10,})/g, '$1***'],
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    value,
  );
}

export function sanitizeLogString(value: string, maxLength = 1_000): string {
  return redactSecrets(value.replace(/[\r\n]/g, ' ')).slice(0, maxLength);
}

export function sanitizeFields(fields: LogFields | undefined): LogFields {
  if (fields === undefined) return {};
  const sanitized: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_FIELD_NAMES.has(key.toLowerCase()) || value === undefined) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    sanitized[key] = typeof value === 'string' ? sanitizeLogString(value) : value;
  }
  return sanitized;
}

export function serializeLogError(error: unknown, options: { includeStack?: boolean } = {}): {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  category?: string;
  responseBody?: string;
  statusCode?: number;
} {
  const candidate = error !== null && typeof error === 'object' ? error as Record<string, unknown> : undefined;
  const chain = errorChain(error);
  const name = error instanceof Error ? error.name : stringProperty(candidate, 'name') ?? 'UnknownError';
  const rawMessage = error instanceof Error ? error.message : stringProperty(candidate, 'message') ?? String(error);
  const rawStack = error instanceof Error ? error.stack : stringProperty(candidate, 'stack');
  const output: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
    category?: string;
    responseBody?: string;
    statusCode?: number;
  } = {
    name: sanitizeLogString(name, 200),
    message: sanitizeLogString(rawMessage),
  };
  const stack = rawStack === undefined || options.includeStack === false
    ? undefined
    : sanitizeLogString(rawStack, 8_000);
  const code = stringProperty(candidate, 'code');
  const category = stringProperty(candidate, 'category');
  const responseBody = firstStringProperty(chain, 'responseBody');
  const statusCode = firstStatusCode(chain);
  if (stack !== undefined) output.stack = stack;
  if (code !== undefined) output.code = sanitizeLogString(code, 200);
  if (category !== undefined) output.category = sanitizeLogString(category, 200);
  if (responseBody !== undefined) output.responseBody = sanitizeLogString(responseBody, 16_000);
  if (statusCode !== undefined) output.statusCode = statusCode;
  return output;
}

function stringProperty(candidate: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = candidate?.[key];
  return typeof value === 'string' ? value : undefined;
}

function errorChain(error: unknown): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  let current = error;
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidate = current as Record<string, unknown>;
    chain.push(candidate);
    current = candidate.cause;
  }
  return chain;
}

function firstStringProperty(
  chain: readonly Record<string, unknown>[],
  key: string,
): string | undefined {
  for (const candidate of chain) {
    const value = stringProperty(candidate, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstStatusCode(chain: readonly Record<string, unknown>[]): number | undefined {
  for (const candidate of chain) {
    const value = candidate.statusCode;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) {
      return value;
    }
  }
  return undefined;
}
