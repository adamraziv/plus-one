import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  ActivateBudgetProposalSchemaV1,
  UpdateObligationProposalSchemaV1,
  UpsertDebtPlanProposalSchemaV1,
  UpsertSavingsGoalProposalSchemaV1,
} from '@plus-one/contracts';
import {
  BudgetRepository,
  DebtPlanRepository,
  ObligationRepository,
  SavingsGoalRepository,
} from '@plus-one/planning';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';
import { seedPlanningHousehold } from '../helpers/planning.js';

let context: PostgresTestContext | undefined;

afterEach(async () => {
  await context?.cleanup();
  context = undefined;
});

describe('planning repositories', () => {
  it('persists planning records and leaves enforcement to PostgreSQL', async () => {
    context = await createPostgresTestContext('planning_repositories');
    const pool = new Pool({ connectionString: context.roleUrls.planning });
    const owner = new Pool({ connectionString: context.migratorUrl });
    const fixture = await seedPlanningHousehold(owner);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const budget = await new BudgetRepository().activate(client, ActivateBudgetProposalSchemaV1.parse({
        schemaName: 'activate-budget-proposal',
        schemaVersion: 1,
        householdId: fixture.householdId,
        scopeKey: 'monthly',
        name: 'June budget',
        validFrom: '2026-06-01',
        validTo: '2026-06-30',
        categories: [{ categoryKey: 'food', name: 'Food' }],
        allocations: [{
          categoryKey: 'food',
          periodStart: '2026-06-01',
          periodEnd: '2026-06-30',
          amount: { amount: '800.00', currency: 'USD' },
        }],
        mappings: [{ categoryKey: 'food', accountId: fixture.expenseAccountId, direction: 'expense', validFrom: '2026-06-01' }],
      }), fixture.context);
      await new ObligationRepository().upsert(client, UpdateObligationProposalSchemaV1.parse({
        schemaName: 'update-obligation-proposal',
        schemaVersion: 1,
        householdId: fixture.householdId,
        obligationKey: 'rent',
        variant: 'bill',
        name: 'Rent',
        lifecycleStatus: 'active',
        recurrence: { frequency: 'monthly', interval: 1, timezone: 'UTC' },
        expectedAmount: { amount: '2500.00', currency: 'USD' },
        dueDay: 1,
        accountId: fixture.expenseAccountId,
        budgetCategoryKey: 'food',
        editScope: 'this_and_future',
        occurrences: [{ occurrenceDate: '2026-06-01', dueDate: '2026-06-01', expectedAmount: { amount: '2500.00', currency: 'USD' } }],
      }), fixture.context);
      await new SavingsGoalRepository().upsert(client, UpsertSavingsGoalProposalSchemaV1.parse({
        schemaName: 'upsert-savings-goal-proposal',
        schemaVersion: 1,
        householdId: fixture.householdId,
        goalKey: 'emergency',
        name: 'Emergency fund',
        target: { amount: '10000.00', currency: 'USD' },
        assetAccountIds: [fixture.assetAccountId],
        virtualAllocations: [{ accountId: fixture.assetAccountId, allocationKey: 'emergency-cash', amount: { amount: '500.00', currency: 'USD' } }],
      }), fixture.context);
      await new DebtPlanRepository().upsert(client, UpsertDebtPlanProposalSchemaV1.parse({
        schemaName: 'upsert-debt-plan-proposal',
        schemaVersion: 1,
        householdId: fixture.householdId,
        debtPlanKey: 'loan',
        liabilityAccountId: fixture.liabilityAccountId,
        name: 'Loan payoff',
        loanAgreement: {
          lenderName: 'Bank',
          principal: { amount: '5000.00', currency: 'USD' },
          annualInterestRate: '0.0500',
          effectiveFrom: '2026-06-01',
          paymentSchedule: { frequency: 'monthly', interval: 1, timezone: 'UTC' },
        },
        strategy: { monthlyPayment: { amount: '300.00', currency: 'USD' }, priority: 1 },
      }), fixture.context);

      await expect(new BudgetRepository().activate(client, ActivateBudgetProposalSchemaV1.parse({
        schemaName: 'activate-budget-proposal',
        schemaVersion: 1,
        householdId: fixture.householdId,
        scopeKey: 'monthly',
        name: 'Overlap budget',
        validFrom: '2026-06-15',
        categories: [{ categoryKey: 'other', name: 'Other' }],
        allocations: [],
        mappings: [],
      }), fixture.context)).rejects.toThrow(/overlap/);

      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await new BudgetRepository().activate(client, ActivateBudgetProposalSchemaV1.parse({
        schemaName: 'activate-budget-proposal',
        schemaVersion: 1,
        householdId: fixture.householdId,
        scopeKey: 'monthly',
        name: 'June budget',
        validFrom: '2026-06-01',
        validTo: '2026-06-30',
        categories: [{ categoryKey: 'food', name: 'Food' }],
        allocations: [],
        mappings: [],
      }), fixture.context);
      await client.query('COMMIT');

      const counts = await owner.query<{ count: string }>(
        'SELECT count(*) FROM planning.domain_audit_records WHERE household_id = $1',
        [fixture.householdDbId],
      );
      expect(counts.rows[0]?.count).toBe('1');
      await expect(owner.query('UPDATE planning.domain_audit_records SET action = action')).rejects.toThrow(/append-only/);
      expect(budget.recordType).toBe('budget_version');
    } finally {
      client.release();
      await pool.end();
      await owner.end();
    }
  });
});
