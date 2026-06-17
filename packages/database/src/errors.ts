import { PlusOneError, type ErrorCategoryV1, type RetryDirectiveV1 } from '@plus-one/contracts';

interface PostgreSqlLikeError {
  code?: unknown;
}

export interface DatabaseErrorContext {
  operation: string;
  receiptLookupRequired?: boolean;
}

const SQL_STATE_MAPPING: Record<
  string,
  { category: ErrorCategoryV1; code: string; retry: RetryDirectiveV1 }
> = {
  '40001': {
    category: 'serialization_conflict',
    code: 'database_serialization_conflict',
    retry: 'after_backoff',
  },
  '40P01': {
    category: 'serialization_conflict',
    code: 'database_deadlock',
    retry: 'after_backoff',
  },
  '55P03': {
    category: 'timeout',
    code: 'database_lock_timeout',
    retry: 'after_backoff',
  },
  '57014': {
    category: 'timeout',
    code: 'database_statement_timeout',
    retry: 'after_backoff',
  },
  '08000': {
    category: 'storage_unavailable',
    code: 'database_connection_failed',
    retry: 'after_backoff',
  },
  '08003': {
    category: 'storage_unavailable',
    code: 'database_connection_failed',
    retry: 'after_backoff',
  },
  '08006': {
    category: 'storage_unavailable',
    code: 'database_connection_failed',
    retry: 'after_backoff',
  },
  '57P01': {
    category: 'storage_unavailable',
    code: 'database_shutdown',
    retry: 'after_backoff',
  },
};

function isConstraintClass(sqlState: string): boolean {
  return sqlState.startsWith('22') || sqlState.startsWith('23') || sqlState.startsWith('2B');
}

export function normalizeDatabaseError(error: unknown, context: DatabaseErrorContext): PlusOneError {
  if (error instanceof PlusOneError) {
    return error;
  }

  const candidate = error as PostgreSqlLikeError;
  const sqlState = typeof candidate?.code === 'string' ? candidate.code : undefined;
  const mapped = sqlState === undefined ? undefined : SQL_STATE_MAPPING[sqlState];
  const normalized = mapped ??
    (sqlState !== undefined && isConstraintClass(sqlState)
      ? {
          category: 'constraint_violation' as const,
          code: 'database_constraint_violation',
          retry: 'never' as const,
        }
      : {
          category: 'storage_unavailable' as const,
          code: 'database_operation_failed',
          retry: 'after_backoff' as const,
        });

  return new PlusOneError({
    ...normalized,
    message:
      normalized.category === 'constraint_violation'
        ? 'The database rejected the requested state'
        : 'Storage is unavailable',
    receiptLookupRequired: context.receiptLookupRequired ?? false,
    details: {
      operation: context.operation,
      ...(sqlState === undefined ? {} : { sqlState }),
    },
    cause: error,
  });
}
