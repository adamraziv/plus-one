import { afterEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createAccountingJournalMutationHandler } from '@plus-one/accounting';
import {
  ProjectionFinalizer,
  ProjectionHealthRepository,
  ProjectionRebuilder,
  ProjectionWriter,
} from '@plus-one/reporting';
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

  it('rolls back journal posting when projection write fails', async () => {
    context = await createPostgresTestContext('reporting_projection_rollback');
    owner = new Pool({ connectionString: context.migratorUrl });
    const seeded = await seedPostedJournalInput(owner);
    accounting = new Pool({ connectionString: context.roleUrls.accounting });
    client = await accounting.connect();
    const handler = createAccountingJournalMutationHandler({
      posting: seeded.postingService({
        applyJournal: async () => {
          throw new Error('projection failed');
        },
      }),
    });

    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await expect(handler.execute(client, seeded.workResult, seeded.commandContext))
      .rejects.toThrow(/Storage is unavailable/);
    await client.query('ROLLBACK');
    client.release();
    client = undefined;

    const journals = await owner.query<{ count: string }>(
      'SELECT count(*) FROM accounting.journals WHERE household_id=$1',
      [seeded.householdDbId],
    );
    const projections = await owner.query<{ count: string }>(
      'SELECT count(*) FROM reporting.account_current_balances WHERE household_id=$1',
      [seeded.householdDbId],
    );
    expect(journals.rows[0]?.count).toBe('0');
    expect(projections.rows[0]?.count).toBe('0');
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

  it('records drift and rebuilds projections from authoritative postings', async () => {
    context = await createPostgresTestContext('reporting_rebuild');
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

    await owner.query(
      `UPDATE reporting.account_current_balances
       SET native_amount=999
       WHERE household_id=$1 AND account_id=$2`,
      [seeded.householdDbId, seeded.cashAccountDbId],
    );

    const health = new ProjectionHealthRepository();
    const drifts = await health.checkCurrentBalanceDrift(owner, {
      householdId: seeded.householdId,
      asOf: '2026-06-20',
    });
    expect(drifts).toHaveLength(1);

    await new ProjectionRebuilder().rebuildCurrentBalances(owner, {
      householdId: seeded.householdId,
      asOf: '2026-06-20',
    });

    const after = await health.checkCurrentBalanceDrift(owner, {
      householdId: seeded.householdId,
      asOf: '2026-06-20',
    });
    expect(after).toHaveLength(0);
  });

  it('records and rebuilds daily balance and net worth drift', async () => {
    context = await createPostgresTestContext('reporting_daily_rebuild');
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
    await owner.query(
      `UPDATE reporting.account_daily_balances
       SET native_amount=999, reporting_amount=999
       WHERE household_id=$1 AND account_id=$2`,
      [seeded.householdDbId, seeded.cashAccountDbId],
    );
    await owner.query(
      `UPDATE reporting.household_net_worth_daily
       SET net_worth_reporting_amount=998
       WHERE household_id=$1 AND balance_date=DATE '2026-06-20'`,
      [seeded.householdDbId],
    );

    const health = new ProjectionHealthRepository();
    await expect(health.checkDailyBalanceDrift(owner, {
      householdId: seeded.householdId,
      balanceDate: '2026-06-20',
    })).resolves.toHaveLength(1);
    await expect(health.checkNetWorthDrift(owner, {
      householdId: seeded.householdId,
      balanceDate: '2026-06-20',
    })).resolves.toHaveLength(1);

    const rebuilder = new ProjectionRebuilder();
    await rebuilder.rebuildDailyBalances(owner, {
      householdId: seeded.householdId,
      balanceDate: '2026-06-20',
    });
    await rebuilder.rebuildNetWorth(owner, {
      householdId: seeded.householdId,
      balanceDate: '2026-06-20',
    });

    await expect(health.checkDailyBalanceDrift(owner, {
      householdId: seeded.householdId,
      balanceDate: '2026-06-20',
    })).resolves.toHaveLength(0);
    await expect(health.checkNetWorthDrift(owner, {
      householdId: seeded.householdId,
      balanceDate: '2026-06-20',
    })).resolves.toHaveLength(0);
  });

  it('uses same-currency native amounts for reporting amounts only', async () => {
    context = await createPostgresTestContext('reporting_currency_guard');
    owner = new Pool({ connectionString: context.migratorUrl });
    const seeded = await seedPostedJournalInput(owner);
    if (seeded.workResult.operation !== 'post') throw new Error('expected post proposal');
    await owner.query(
      `UPDATE accounting.accounts
       SET native_currency='EUR'
       WHERE household_id=$1 AND account_id=$2`,
      [seeded.householdDbId, seeded.foodAccountId],
    );
    const proposal = JSON.parse(JSON.stringify(seeded.workResult));
    proposal.draft.journal.postings[1] = {
      ...proposal.draft.journal.postings[1]!,
      accountNativeAmount: '18.40',
      accountNativeCurrency: 'EUR',
      exchangeRate: '0.92',
      exchangeRateQuote: 'native_per_transaction',
      exchangeRateDate: '2026-06-20',
      exchangeRateSource: 'test-rate',
    };
    accounting = new Pool({ connectionString: context.roleUrls.accounting });
    client = await accounting.connect();
    const handler = createAccountingJournalMutationHandler({
      posting: seeded.postingService(new ProjectionWriter()),
    });
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await handler.execute(client, proposal, seeded.commandContext);
    await client.query('COMMIT');
    client.release();
    client = undefined;

    const balances = await owner.query<{ native_currency: string; reporting_amount: string }>(
      `SELECT native_currency, reporting_amount::text
       FROM reporting.account_current_balances
       WHERE household_id=$1
       ORDER BY native_currency`,
      [seeded.householdDbId],
    );
    expect(balances.rows).toEqual([
      { native_currency: 'EUR', reporting_amount: '0.000000000000' },
      { native_currency: 'USD', reporting_amount: '-20.000000000000' },
    ]);
  });
});
