import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  CashFlowMutationService,
} from '@plus-one/planning';
import {
  UpdateObligationProposalSchemaV1,
  UpsertDebtPlanProposalSchemaV1,
  UpsertSavingsGoalProposalSchemaV1,
} from '@plus-one/contracts';
import {
  checkedPlanningResult,
  createPlanningMutationCoordinator,
  seedPlanningTeamFixture,
} from '../helpers/planning-team.js';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

describe('CashFlowMutationService', () => {
  it('executes obligation, savings-goal, and debt-plan proposals through the existing planning handlers', async () => {
    const cases = [
      {
        label: 'obligation',
        workCellId: 'cash-flow-obligation',
        schema: { schemaName: 'update-obligation-proposal', schemaVersion: 1 as const },
        output: (planning: Awaited<ReturnType<typeof seedPlanningTeamFixture>>['planning']) => UpdateObligationProposalSchemaV1.parse({
          schemaName: 'update-obligation-proposal',
          schemaVersion: 1,
          householdId: planning.householdId,
          obligationKey: 'rent',
          variant: 'bill',
          name: 'Rent',
          lifecycleStatus: 'active',
          recurrence: { frequency: 'monthly', interval: 1, timezone: 'UTC' },
          expectedAmount: { amount: '2500.00', currency: 'USD' },
          dueDay: 1,
          editScope: 'this_and_future',
          occurrences: [{ occurrenceDate: '2026-07-01', dueDate: '2026-07-01', expectedAmount: { amount: '2500.00', currency: 'USD' } }],
        }),
        commandType: 'update_obligation',
      },
      {
        label: 'savings',
        workCellId: 'cash-flow-savings-goal',
        schema: { schemaName: 'upsert-savings-goal-proposal', schemaVersion: 1 as const },
        output: (planning: Awaited<ReturnType<typeof seedPlanningTeamFixture>>['planning']) => UpsertSavingsGoalProposalSchemaV1.parse({
          schemaName: 'upsert-savings-goal-proposal',
          schemaVersion: 1,
          householdId: planning.householdId,
          goalKey: 'emergency',
          name: 'Emergency fund',
          target: { amount: '5000.00', currency: 'USD' },
          assetAccountIds: [planning.assetAccountId],
          virtualAllocations: [],
        }),
        commandType: 'upsert_savings_goal',
      },
      {
        label: 'debt',
        workCellId: 'cash-flow-debt-plan',
        schema: { schemaName: 'upsert-debt-plan-proposal', schemaVersion: 1 as const },
        output: (planning: Awaited<ReturnType<typeof seedPlanningTeamFixture>>['planning']) => UpsertDebtPlanProposalSchemaV1.parse({
          schemaName: 'upsert-debt-plan-proposal',
          schemaVersion: 1,
          householdId: planning.householdId,
          debtPlanKey: 'loan',
          liabilityAccountId: planning.liabilityAccountId,
          name: 'Loan payoff',
          loanAgreement: {
            lenderName: 'Bank',
            principal: { amount: '5000.00', currency: 'USD' },
            annualInterestRate: '0.0500',
            effectiveFrom: '2026-07-01',
            paymentSchedule: { frequency: 'monthly', interval: 1, timezone: 'UTC' },
          },
          strategy: { monthlyPayment: { amount: '300.00', currency: 'USD' }, priority: 1 },
        }),
        commandType: 'upsert_debt_plan',
      },
    ] as const;

    for (const [index, entry] of cases.entries()) {
      const context: PostgresTestContext = await createPostgresTestContext(`cash_flow_team_${entry.label}`);
      const owner = new Pool({ connectionString: context.migratorUrl });
      const { planning } = await seedPlanningTeamFixture(owner, 80 + index);
      const output = entry.output(planning);
      const harness = await createPlanningMutationCoordinator(owner, context, checkedPlanningResult({
        householdId: planning.householdId,
        householdDbId: planning.householdDbId,
        taskId: planning.context.taskId,
        team: 'cash-flow',
        workCellId: entry.workCellId,
        outputSchema: entry.schema,
        output: JSON.parse(JSON.stringify(output)),
        claimId: entry.commandType,
        claimText: entry.commandType + ' is ready for checked execution.',
      }));
      try {
        const result = await new CashFlowMutationService(harness.coordinator).execute({
          workCellInput: {
            householdId: planning.householdId,
            taskId: planning.context.taskId,
            team: 'cash-flow',
            workCellId: entry.workCellId,
          } as never,
          commandId: planning.context.commandId,
          idempotencyKey: planning.context.idempotencyKey,
        });
        expect(result.mutation.receipt.commandType).toBe(entry.commandType);
      } finally {
        await harness.close();
        await owner.end();
        await context.cleanup();
      }
    }
  });
});
