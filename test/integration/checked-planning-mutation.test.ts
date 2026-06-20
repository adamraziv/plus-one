import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { ActivateBudgetCommandAdapter, PlanningCommandHandlers } from '@plus-one/planning';
import { createExecutor } from '../helpers/checked-mutation.js';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';
import { seedCheckedPlanningBudgetMutation } from '../helpers/planning.js';

let context: PostgresTestContext | undefined;
let closeHarness: (() => Promise<void>) | undefined;
let owner: Pool | undefined;

afterEach(async () => {
  await closeHarness?.();
  closeHarness = undefined;
  await owner?.end();
  owner = undefined;
  await context?.cleanup();
  context = undefined;
});

describe('checked planning mutations', () => {
  it('commits a planning command once and returns the same receipt on replay', async () => {
    context = await createPostgresTestContext('checked_planning');
    owner = new Pool({ connectionString: context.migratorUrl });
    const { command } = await seedCheckedPlanningBudgetMutation(owner, new ActivateBudgetCommandAdapter());
    const harness = createExecutor(context, PlanningCommandHandlers, 'planning');
    closeHarness = harness.close;

    const first = await harness.executor.execute(command);
    const second = await harness.executor.execute(command);

    expect(first.receipt.receiptId).toBe(second.receipt.receiptId);
    expect(first.readback.ok).toBe(true);

    const versions = await owner.query<{ count: string }>(
      'SELECT count(*) FROM planning.budget_versions WHERE household_id = (SELECT id FROM operations.households WHERE household_id = $1)',
      [command.householdId],
    );
    expect(versions.rows[0]?.count).toBe('1');
  });
});
