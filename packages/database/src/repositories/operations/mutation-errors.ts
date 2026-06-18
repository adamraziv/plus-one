import { PlusOneError } from '@plus-one/contracts';
import { normalizeDatabaseError } from '../../errors.js';

interface PgFailure {
  code?: string;
  constraint?: string;
  message?: string;
}

export function normalizeMutationDatabaseError(error: unknown): PlusOneError {
  if (error instanceof PlusOneError) return error;
  const failure = error as PgFailure;
  if (failure.code === '23514'
    && (failure.constraint === 'mutation_command_acceptance_required'
      || failure.message?.includes('accepting checker verdict') === true)) {
    return new PlusOneError({
      category: 'checker_rejected',
      code: 'exact_checker_acceptance_required',
      message: 'Mutation command lacks an accepting verdict for the exact proposal',
      retry: 'never',
      receiptLookupRequired: false,
      details: { constraint: failure.constraint ?? 'unknown' },
      cause: error,
    });
  }
  if (failure.code === '23514' && [
    'mutation_command_exact_confirmation',
    'mutation_command_confirmation_required',
  ].includes(failure.constraint ?? '')) {
    return new PlusOneError({
      category: 'confirmation_required',
      code: 'exact_external_confirmation_required',
      message: 'Mutation command lacks a matching external confirmation observation',
      retry: 'after_state_resolution',
      receiptLookupRequired: false,
      details: { constraint: failure.constraint ?? 'unknown' },
      cause: error,
    });
  }
  if (failure.code === '23514' && [
    'mutation_command_exact_artifact',
    'mutation_command_task_not_ready',
  ].includes(failure.constraint ?? '')) {
    return new PlusOneError({
      category: 'validation_rejected',
      code: 'checked_proposal_identity_mismatch',
      message: 'Mutation command does not match the current exact maker artifact',
      retry: 'never',
      receiptLookupRequired: false,
      details: { constraint: failure.constraint ?? 'unknown' },
      cause: error,
    });
  }
  if (failure.code === '23514' && [
    'mutation_command_not_executable',
    'mutation_command_not_pending',
    'mutation_command_status_transition',
    'mutation_command_task_not_execution_pending',
    'mutation_command_receipt_required',
    'mutation_command_readback_required',
    'mutation_command_claim_required',
  ].includes(failure.constraint ?? '')) {
    return new PlusOneError({
      category: 'serialization_conflict',
      code: 'mutation_command_state_conflict',
      message: 'Mutation command state changed before the operation completed',
      retry: 'after_state_resolution',
      receiptLookupRequired: true,
      details: { constraint: failure.constraint ?? 'unknown' },
      cause: error,
    });
  }
  return normalizeDatabaseError(error, { operation: 'mutation-command' });
}
