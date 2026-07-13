import { describe, expect, it } from 'vitest';
import {
  createTransientModelRetryProcessor,
  isTransientModelError,
} from '../index.js';

describe('isTransientModelError', () => {
  it.each([
    new Error('Inference capacity queue is full'),
    new Error('Upstream request failed'),
    Object.assign(new Error('rate limit exceeded'), { statusCode: 429 }),
    Object.assign(new Error('service unavailable'), { status: 503 }),
    Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
    {
      message: 'wrapped provider failure',
      cause: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
    },
    Object.assign(new Error('provider rejected the request'), { isRetryable: true }),
  ])('classifies a transient provider failure', (error) => {
    expect(isTransientModelError(error)).toBe(true);
  });

  it.each([
    new Error('Zod validation failed'),
    Object.assign(new Error('unauthorized'), { status: 401 }),
    Object.assign(new Error('bad request'), { statusCode: 400 }),
    Object.assign(new Error('forbidden'), { code: 'permission_denied' }),
    null,
  ])('does not classify a permanent or application failure as transient', (error) => {
    expect(isTransientModelError(error)).toBe(false);
  });
});

describe('createTransientModelRetryProcessor', () => {
  it('retries matching provider failures only within the configured budget', async () => {
    const processor = createTransientModelRetryProcessor({ maxRetries: 2, baseDelayMs: 0 });
    const error = new Error('Inference capacity queue is full');

    await expect(processor.processAPIError(apiErrorArgs(error, 0))).resolves.toEqual({ retry: true });
    await expect(processor.processAPIError(apiErrorArgs(error, 1))).resolves.toEqual({ retry: true });
    await expect(processor.processAPIError(apiErrorArgs(error, 2))).resolves.toBeUndefined();
  });

  it('does not retry validation failures', async () => {
    const processor = createTransientModelRetryProcessor({ maxRetries: 2, baseDelayMs: 0 });

    await expect(processor.processAPIError(apiErrorArgs(
      new Error('Zod validation failed'),
      0,
    ))).resolves.toBeUndefined();
  });
});

function apiErrorArgs(error: unknown, retryCount: number) {
  return {
    error,
    retryCount,
    stepNumber: 0,
    steps: [],
    state: {},
    abortSignal: new AbortController().signal,
  } as never;
}
