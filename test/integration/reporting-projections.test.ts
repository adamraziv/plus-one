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

describe('reporting projections', () => {
  it('updates current balances in the same transaction as journal posting', async () => {
    context = await createPostgresTestContext('reporting_projection');
    owner = new Pool({ connectionString: context.migratorUrl });
    const seeded = await seedPostedJournalInput(owner);
    accounting = new Pool({ connectionString: context.roleUrls.accounting });
    client = await accounting.connect();
    const handler = createAccountingJournalMutationHandler({
      posting: seeded.postingService(new ProjectionWriter()),
    });

    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      await handler.execute(client, seeded.workResult, seeded.commandContext);
      const projected = await client.query<{ native_amount: string }>(
        `SELECT native_amount::text FROM reporting.account_current_balances
         WHERE household_id=$1 AND account_id=$2`,
        [seeded.householdDbId, seeded.cashAccountDbId],
      );
      expect(projected.rows[0]?.native_amount).toBe('-20.000000000000');
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

  it('finalizes daily balances and household net worth deterministically', async () => {
    context = await createPostgresTestContext('reporting_finalizer');
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
    client.release();
    client = undefined;

    const finalizer = new ProjectionFinalizer();
    await finalizer.finalizeDay(owner, {
      householdId: seeded.householdId,
      balanceDate: '2026-06-20',
    });
    await finalizer.finalizeDay(owner, {
      householdId: seeded.householdId,
      balanceDate: '2026-06-20',
    });

    const netWorth = await owner.query<{ net_worth_reporting_amount: string }>(
      `SELECT net_worth_reporting_amount::text
       FROM reporting.household_net_worth_daily
       WHERE household_id=$1 AND balance_date='2026-06-20'`,
      [seeded.householdDbId],
    );
    expect(netWorth.rows[0]?.net_worth_reporting_amount).toBe('-20.000000000000');
  });
});
