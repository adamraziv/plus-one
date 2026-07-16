import type { CheckedMutationCommandAdapter } from '@plus-one/mutations';
import { CheckedCommandSchemaV1, PlusOneError } from '@plus-one/contracts';
import {
  AccountingClarificationSchemaV1,
  AccountingWorkResultSchemaV1,
  ChartOfAccountsProposalSchemaV1,
} from '../team/contracts.js';

export class AccountingJournalCommandAdapter implements CheckedMutationCommandAdapter {
  buildCommand(input: Parameters<CheckedMutationCommandAdapter['buildCommand']>[0]) {
    const payload = AccountingWorkResultSchemaV1.parse(input.payload);
    if (AccountingClarificationSchemaV1.safeParse(payload).success) {
      throw new PlusOneError({
        category: 'validation_rejected',
        code: 'accounting_clarification_not_executable',
        message: 'A clarification result cannot become a mutation command',
        retry: 'never',
        receiptLookupRequired: false,
        details: {},
      });
    }
    return CheckedCommandSchemaV1.parse({
      schemaName: 'checked-command' as const, schemaVersion: 1 as const,
      ...input, commandType: 'apply_accounting_journal_mutation' as const, payload,
    });
  }
}

export class ChartOfAccountsCommandAdapter implements CheckedMutationCommandAdapter {
  buildCommand(input: Parameters<CheckedMutationCommandAdapter['buildCommand']>[0]) {
    const payload = ChartOfAccountsProposalSchemaV1.parse(input.payload);
    return CheckedCommandSchemaV1.parse({
      schemaName: 'checked-command' as const, schemaVersion: 1 as const,
      ...input, commandType: 'apply_chart_of_accounts_change' as const, payload,
    });
  }
}
