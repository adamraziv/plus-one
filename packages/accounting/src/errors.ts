// packages/accounting/src/errors.ts
import { PlusOneError } from '@plus-one/contracts';
import { normalizeDatabaseError } from '@plus-one/database';

interface PgFailure { code?: string; constraint?: string }

export function normalizeAccountingError(error: unknown): PlusOneError {
  if (error instanceof PlusOneError) return error;
  const failure = error as PgFailure;
  if (failure.code === '23514' && failure.constraint === 'journals_open_period_required') {
    return new PlusOneError({
      category: 'period_closed', code: 'journal_period_closed',
      message: 'The accounting period is closed or does not contain the effective date',
      retry: 'after_state_resolution', receiptLookupRequired: false,
      details: { ...(failure.constraint === undefined ? {} : { constraint: failure.constraint }) },
      cause: error,
    });
  }
  if (failure.code === '23514' && [
    'journals_latest_draft_only', 'journals_accepted_artifact_required',
    'journals_exact_draft_metadata', 'journals_exact_draft_postings',
  ].includes(failure.constraint ?? '')) {
    return new PlusOneError({
      category: 'checker_rejected', code: 'checked_draft_mismatch',
      message: 'The journal does not match the latest exactly accepted draft artifact',
      retry: 'never', receiptLookupRequired: false,
      details: { ...(failure.constraint === undefined ? {} : { constraint: failure.constraint }) },
      cause: error,
    });
  }
  if (failure.code === '55000'
    && failure.constraint === 'accounts_posted_identity_immutable') {
    return new PlusOneError({
      category: 'constraint_violation', code: 'posted_account_financial_identity_immutable',
      message: 'Posted account class, normal balance, native currency, and identity are immutable',
      retry: 'never', receiptLookupRequired: false,
      details: { ...(failure.constraint === undefined ? {} : { constraint: failure.constraint }) }, cause: error,
    });
  }
  if (failure.code === '23505'
    && failure.constraint === 'account_source_mappings_active_identity') {
    return new PlusOneError({
      category: 'duplicate_replay', code: 'active_account_source_mapping_exists',
      message: 'The source account identity already has an active mapping',
      retry: 'after_state_resolution', receiptLookupRequired: false,
      details: { ...(failure.constraint === undefined ? {} : { constraint: failure.constraint }) }, cause: error,
    });
  }
  return normalizeDatabaseError(error, { operation: 'accounting' });
}
