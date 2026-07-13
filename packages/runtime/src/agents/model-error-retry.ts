import { StreamErrorRetryProcessor } from '@mastra/core/processors';

const TRANSIENT_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);
const TRANSIENT_MESSAGE = /capacity queue is full|upstream request failed|rate.?limit|overload|temporar(?:y|ily) unavailable|service unavailable|timed? out|timeout|connection reset|socket hang up/i;

export class ModelTemporarilyUnavailableError extends Error {
  readonly code = 'model_temporarily_unavailable';
  readonly isRetryable = true;

  constructor() {
    super('The model provider remained temporarily unavailable after bounded retries.');
    this.name = 'ModelTemporarilyUnavailableError';
  }
}

export function stopAfterSemanticModelSteps(maxSemanticSteps: number) {
  if (!Number.isInteger(maxSemanticSteps) || maxSemanticSteps < 1) {
    throw new RangeError('maxSemanticSteps must be a positive integer.');
  }
  return ({ steps }: { steps: readonly unknown[] }): boolean =>
    steps.filter((step) => finishReasonOf(step) !== 'retry').length >= maxSemanticSteps;
}

export function modelResultEndedOnRetry(result: unknown): boolean {
  if (finishReasonOf(result) === 'retry') return true;
  const steps = asRecord(result).steps;
  return Array.isArray(steps) && steps.length > 0 && finishReasonOf(steps.at(-1)) === 'retry';
}

export function isTransientModelError(error: unknown): boolean {
  for (const candidate of errorChain(error)) {
    const record = asRecord(candidate);
    if (record.isRetryable === true || record.retryable === true) return true;

    const status = numericProperty(record, 'statusCode') ?? numericProperty(record, 'status');
    if (status !== undefined && TRANSIENT_STATUS_CODES.has(status)) return true;

    const code = typeof record.code === 'string' ? record.code.toUpperCase() : undefined;
    if (code !== undefined && TRANSIENT_CODES.has(code)) return true;

    const message = candidate instanceof Error
      ? candidate.message
      : typeof record.message === 'string' ? record.message : '';
    if (TRANSIENT_MESSAGE.test(message)) return true;
  }
  return false;
}

export function createTransientModelRetryProcessor(input: {
  maxRetries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}): StreamErrorRetryProcessor {
  return new StreamErrorRetryProcessor({
    maxRetries: input.maxRetries,
    matchers: [isTransientModelError],
    delayMs: ({ retryCount }) => {
      const baseDelayMs = input.baseDelayMs ?? 250;
      const maxDelayMs = input.maxDelayMs ?? 1_000;
      const exponentialDelayMs = Math.min(maxDelayMs, baseDelayMs * (2 ** retryCount));
      if (exponentialDelayMs <= 0) return 0;
      return exponentialDelayMs + Math.floor(Math.random() * Math.max(1, exponentialDelayMs / 4));
    },
  });
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const visited = new Set<unknown>();
  let candidate: unknown = error;
  while (candidate !== null && candidate !== undefined && !visited.has(candidate)) {
    chain.push(candidate);
    visited.add(candidate);
    candidate = asRecord(candidate).cause;
  }
  return chain;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {};
}

function numericProperty(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value);
  return undefined;
}

function finishReasonOf(value: unknown): unknown {
  return asRecord(value).finishReason;
}
