import { PlusOneError } from '@plus-one/contracts';
import type { CheckedMutationWorkCellCoordinator } from '@plus-one/mutations';
import {
  ActivateBudgetCommandAdapter,
  UpdateObligationCommandAdapter,
  UpsertDebtPlanCommandAdapter,
  UpsertSavingsGoalCommandAdapter,
} from '../mutations/command-adapters.js';

type ExecuteInput = Parameters<CheckedMutationWorkCellCoordinator['execute']>[0];
type WorkCellInput = ExecuteInput['workCellInput'] & { workCellId: string };

export class BudgetingMutationService {
  constructor(
    private readonly coordinator: Pick<CheckedMutationWorkCellCoordinator, 'execute'>,
  ) {}

  async execute(input: {
    workCellInput: WorkCellInput;
    commandId: string;
    idempotencyKey: string;
  }) {
    if (input.workCellInput.workCellId !== 'budget-plan') {
      throw new PlusOneError({
        category: 'policy_rejected',
        code: 'planning_mutation_cell_invalid',
        message: 'Only budget-plan may enter checked mutation execution',
        retry: 'never',
        receiptLookupRequired: false,
        details: { workCellId: input.workCellInput.workCellId },
      });
    }
    return this.coordinator.execute({
      workCellInput: input.workCellInput,
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      adapter: new ActivateBudgetCommandAdapter(),
    });
  }
}

export class CashFlowMutationService {
  constructor(
    private readonly coordinator: Pick<CheckedMutationWorkCellCoordinator, 'execute'>,
  ) {}

  async execute(input: {
    workCellInput: WorkCellInput;
    commandId: string;
    idempotencyKey: string;
  }) {
    const adapter = input.workCellInput.workCellId === 'cash-flow-obligation'
      ? new UpdateObligationCommandAdapter()
      : input.workCellInput.workCellId === 'cash-flow-savings-goal'
        ? new UpsertSavingsGoalCommandAdapter()
        : input.workCellInput.workCellId === 'cash-flow-debt-plan'
          ? new UpsertDebtPlanCommandAdapter()
          : undefined;
    if (adapter === undefined) {
      throw new PlusOneError({
        category: 'policy_rejected',
        code: 'planning_mutation_cell_invalid',
        message: 'Only cash-flow planning cells may enter checked mutation execution',
        retry: 'never',
        receiptLookupRequired: false,
        details: { workCellId: input.workCellInput.workCellId },
      });
    }
    return this.coordinator.execute({
      workCellInput: input.workCellInput,
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      adapter,
    });
  }
}
