import { afterEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createAccountingJournalMutationHandler } from '@plus-one/accounting';
import { ProjectionWriter } from '@plus-one/reporting';
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
  it('uses bounded household/date predicates for current balance reads', async () => {
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
       WHERE household_id=$1 AND as_of <= DATE '2026-06-20'`,
      [seeded.householdDbId],
    );
    expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n'))
      .toMatch(/account_current_balances/);
  });
});
