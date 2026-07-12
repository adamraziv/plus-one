import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { LogContext } from './types.js';

const storage = new AsyncLocalStorage<LogContext>();

export function createRequestId(): string {
  return `req_${randomUUID()}`;
}

export function getLogContext(): LogContext {
  return storage.getStore() ?? {};
}

export async function withLogContext<T>(
  context: LogContext,
  callback: () => Promise<T>,
): Promise<T> {
  return storage.run({ ...getLogContext(), ...context }, callback);
}
