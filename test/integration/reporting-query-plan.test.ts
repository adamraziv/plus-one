import { afterEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createAccountingJournalMutationHandler } from '@plus-one/accounting';
import { ProjectionFinalizer, ProjectionWriter } from '@plus-one/reporting';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';
import { seedPostedJournalInput } from '../helpers/reporting.js';

let context: PostgresTestContext | undefined;
let owner: Pool | undefined;
let accounting: Pool | undefined;
let client: PoolClient | undefined;

afterEach(async () => {
  client?.release();
  await accounting?.end();
  await owner?.end();
  await context?.cleanup();
  client = undefined;
  accounting = undefined;
  owner = undefined;
  context = undefined;
});

describe('reporting query plans', () => {
  it('uses bounded household/date/account predicates for projection reads', async () => {
    context = await createPostgresTestContext('reporting_query_plan');
    owner = new Pool({ connectionString: context.migratorUrl });
    const seeded = await seedPostedJournalInput(owner);
    accounting = new Pool({ connectionString: context.roleUrls.accounting });
    client = await accounting.connect();
    const handler = createAccountingJournalMutationHandler({
      posting: seeded.postingService(new ProjectionWriter()),
    });
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await handler.execute(client, seeded.workResult, seeded.commandContext);
    await client.query('COMMIT');

    const plan = await owner.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
       SELECT * FROM reporting.account_current_balances
       WHERE household_id=$1 AND account_id=$2 AND as_of <= DATE '2026-06-20'`,
      [seeded.householdDbId, seeded.cashAccountDbId],
    );
    expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n'))
      .toMatch(/account_current_balances/);

    await new ProjectionFinalizer().finalizeDay(owner, {
      householdId: seeded.householdId,
      balanceDate: '2026-06-20',
    });

    const dailyPlan = await owner.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
       SELECT * FROM reporting.account_daily_balances
       WHERE household_id=$1 AND account_id=$2 AND balance_date = DATE '2026-06-20'`,
      [seeded.householdDbId, seeded.cashAccountDbId],
    );
    expect(dailyPlan.rows.map((row) => row['QUERY PLAN']).join('\n'))
      .toMatch(/account_daily_balances/);

    const netWorthPlan = await owner.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
       SELECT * FROM reporting.household_net_worth_daily
       WHERE household_id=$1 AND balance_date = DATE '2026-06-20'`,
      [seeded.householdDbId],
    );
    expect(netWorthPlan.rows.map((row) => row['QUERY PLAN']).join('\n'))
      .toMatch(/household_net_worth_daily/);
  });
});
