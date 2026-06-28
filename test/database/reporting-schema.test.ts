import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext;

beforeAll(async () => {
  context = await createPostgresTestContext('reporting_schema');
});

afterAll(async () => {
  await context.cleanup();
});

describe('reporting schema', () => {
  it('creates projection tables, curated views, and metadata for every relation', async () => {
    const { Pool } = await import('pg');
    const owner = new Pool({ connectionString: context.migratorUrl });
    try {
      const tables = await owner.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema='reporting' AND table_type='BASE TABLE'
         ORDER BY table_name`,
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual(expect.arrayContaining([
        'account_current_balances',
        'account_daily_balances',
        'household_net_worth_daily',
        'projection_health',
        'projection_drift_records',
        'relation_metadata',
      ]));

      const views = await owner.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.views
         WHERE table_schema='reporting'
         ORDER BY table_name`,
      );
      expect(views.rows.map((row) => row.table_name)).toEqual(expect.arrayContaining([
        'accounts',
        'current_balances',
        'journal_activity',
        'categorized_transactions',
        'cash_flow_monthly',
        'obligation_occurrences',
        'budget_variance',
        'savings_goal_progress',
        'debt_progress',
        'reconciliation_status',
        'source_freshness',
      ]));

      const metadata = await owner.query<{ relation_name: string }>(
        'SELECT relation_name FROM reporting.relation_metadata ORDER BY relation_name',
      );
      expect(metadata.rows.map((row) => row.relation_name)).toContain('reporting.current_balances');
      expect(metadata.rows.map((row) => row.relation_name)).toContain('reporting.category_spend_monthly');
      expect(metadata.rows).toHaveLength(14);

      const currentBalanceHousehold = await owner.query<{ data_type: string }>(
        `SELECT data_type FROM information_schema.columns
         WHERE table_schema='reporting' AND table_name='current_balances' AND column_name='household_id'`,
      );
      expect(currentBalanceHousehold.rows[0]?.data_type).toBe('text');
    } finally {
      await owner.end();
    }
  });

  it('grants query role reporting reads through public reporting views', async () => {
    const { Pool } = await import('pg');
    const owner = new Pool({ connectionString: context.migratorUrl });
    try {
      const privileges = await owner.query<{ can_select: boolean }>(
        `SELECT has_table_privilege('plus_one_query','reporting.current_balances','SELECT') AS can_select`,
      );
      expect(privileges.rows[0]?.can_select).toBe(true);
    } finally {
      await owner.end();
    }
  });
});
