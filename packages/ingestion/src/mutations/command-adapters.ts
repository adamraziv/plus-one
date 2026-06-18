import { CheckedCommandSchemaV1, PlusOneError, type CheckedCommandV1 } from '@plus-one/contracts';
import type { CheckedMutationCommandAdapter } from '@plus-one/mutations';
import {
  ConfirmImportBatchProposalSchemaV1,
  PeriodCloseProposalSchemaV1,
  PeriodReopenProposalSchemaV1,
  ReconciliationProposalSchemaV1,
} from '../contracts.js';

type AdapterInput = Parameters<CheckedMutationCommandAdapter['buildCommand']>[0];

const command = (
  input: AdapterInput,
  commandType: string,
  schema: { parse(value: unknown): unknown },
  confirmation: 'required' | 'optional',
): CheckedCommandV1 => {
  if (confirmation === 'required' && input.confirmationId === undefined) {
    throw new PlusOneError({
      category: 'confirmation_required',
      code: `${commandType}_confirmation_required`,
      message: 'This checked proposal requires an exact external confirmation',
      retry: 'after_state_resolution',
      receiptLookupRequired: false,
      details: {},
    });
  }
  return CheckedCommandSchemaV1.parse({
    schemaName: 'checked-command',
    schemaVersion: 1,
    ...input,
    commandType,
    payload: schema.parse(input.payload),
  });
};

export class ConfirmImportBatchCommandAdapter implements CheckedMutationCommandAdapter {
  buildCommand(input: AdapterInput): CheckedCommandV1 {
    return command(input, 'confirm_import_batch', ConfirmImportBatchProposalSchemaV1, 'required');
  }
}

export class RecordReconciliationCommandAdapter implements CheckedMutationCommandAdapter {
  buildCommand(input: AdapterInput): CheckedCommandV1 {
    return command(input, 'record_reconciliation', ReconciliationProposalSchemaV1, 'optional');
  }
}

export class ClosePeriodCommandAdapter implements CheckedMutationCommandAdapter {
  buildCommand(input: AdapterInput): CheckedCommandV1 {
    return command(input, 'close_accounting_period', PeriodCloseProposalSchemaV1, 'optional');
  }
}

export class ReopenPeriodCommandAdapter implements CheckedMutationCommandAdapter {
  buildCommand(input: AdapterInput): CheckedCommandV1 {
    return command(input, 'reopen_accounting_period', PeriodReopenProposalSchemaV1, 'required');
  }
}
