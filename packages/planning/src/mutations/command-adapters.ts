import {
  ActivateBudgetProposalSchemaV1,
  ArchivePlanningRecordProposalSchemaV1,
  CheckedCommandSchemaV1,
  UpdateObligationProposalSchemaV1,
  UpsertDebtPlanProposalSchemaV1,
  UpsertSavingsGoalProposalSchemaV1,
  type CheckedCommandV1,
} from '@plus-one/contracts';
import type { CheckedMutationCommandAdapter } from '@plus-one/mutations';

type AdapterInput = Parameters<CheckedMutationCommandAdapter['buildCommand']>[0];

function command(input: AdapterInput, commandType: string, schema: { parse(value: unknown): unknown }): CheckedCommandV1 {
  const payload = schema.parse(input.payload);
  return CheckedCommandSchemaV1.parse({
    schemaName: 'checked-command',
    schemaVersion: 1,
    ...input,
    commandType,
    payload,
  });
}

export class ActivateBudgetCommandAdapter implements CheckedMutationCommandAdapter {
  buildCommand(input: AdapterInput): CheckedCommandV1 {
    return command(input, 'activate_budget', ActivateBudgetProposalSchemaV1);
  }
}

export class UpdateObligationCommandAdapter implements CheckedMutationCommandAdapter {
  buildCommand(input: AdapterInput): CheckedCommandV1 {
    return command(input, 'update_obligation', UpdateObligationProposalSchemaV1);
  }
}

export class UpsertSavingsGoalCommandAdapter implements CheckedMutationCommandAdapter {
  buildCommand(input: AdapterInput): CheckedCommandV1 {
    return command(input, 'upsert_savings_goal', UpsertSavingsGoalProposalSchemaV1);
  }
}

export class UpsertDebtPlanCommandAdapter implements CheckedMutationCommandAdapter {
  buildCommand(input: AdapterInput): CheckedCommandV1 {
    return command(input, 'upsert_debt_plan', UpsertDebtPlanProposalSchemaV1);
  }
}

export class ArchivePlanningRecordCommandAdapter implements CheckedMutationCommandAdapter {
  buildCommand(input: AdapterInput): CheckedCommandV1 {
    return command(input, 'archive_planning_record', ArchivePlanningRecordProposalSchemaV1);
  }
}
