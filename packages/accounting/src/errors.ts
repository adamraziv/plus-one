import { PlusOneError } from '@plus-one/contracts';
import { normalizeDatabaseError } from '@plus-one/database';

export function normalizeAccountingError(error: unknown): PlusOneError {
  if (error instanceof PlusOneError) return error;
  return normalizeDatabaseError(error, { operation: 'accounting' });
}
