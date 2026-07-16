import { PlusOneError } from '@plus-one/contracts';
import type { CheckedMutationWorkCellCoordinator } from '@plus-one/mutations';
import {
  AccountingJournalCommandAdapter,
  ChartOfAccountsCommandAdapter,
} from '../mutations/command-adapters.js';

type CoordinatorExecuteInput = Parameters<CheckedMutationWorkCellCoordinator['execute']>[0];
type WorkCellInput = CoordinatorExecuteInput['workCellInput'];

export class AccountingMutationService {
  constructor(
    private readonly coordinator: Pick<CheckedMutationWorkCellCoordinator, 'execute' | 'prepare'>,
  ) {}

  async prepareChart(input: {
    workCellInput: WorkCellInput;
    commandId: string;
    idempotencyKey: string;
  }) {
    if (input.workCellInput.workCell.workCellId !== 'chart-of-accounts') {
      throw new PlusOneError({
        category: 'policy_rejected',
        code: 'chart_mutation_cell_required',
        message: 'Only chart-of-accounts may enter chart preparation',
        retry: 'never',
        receiptLookupRequired: false,
        details: { workCellId: input.workCellInput.workCell.workCellId },
      });
    }
    return this.coordinator.prepare({
      workCellInput: input.workCellInput,
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      adapter: new ChartOfAccountsCommandAdapter(),
    });
  }

  async execute(input: {
    workCellId: 'transaction-capture' | 'journal' | 'chart-of-accounts';
    workCellInput: WorkCellInput;
    commandId: string;
    idempotencyKey: string;
    confirmationId?: string;
  }): ReturnType<CheckedMutationWorkCellCoordinator['execute']> {
    if (input.workCellId === 'chart-of-accounts' && input.confirmationId === undefined) {
      throw new PlusOneError({
        category: 'confirmation_required',
        code: 'chart_confirmation_required',
        message: 'Every chart change requires an external confirmation reference',
        retry: 'after_state_resolution',
        receiptLookupRequired: false,
        details: { workCellId: input.workCellId },
      });
    }
    return this.coordinator.execute({
      workCellInput: input.workCellInput,
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      ...(input.confirmationId === undefined ? {} : { confirmationId: input.confirmationId }),
      adapter: input.workCellId === 'chart-of-accounts'
        ? new ChartOfAccountsCommandAdapter()
        : new AccountingJournalCommandAdapter(),
    });
  }
}
