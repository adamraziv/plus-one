import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext;

beforeAll(async () => {
  context = await createPostgresTestContext('planning_schema');
});

afterAll(async () => {
  await context.cleanup();
});

describe('planning schema', () => {
  it('creates planning tables and denies query role base-table access', async () => {
    const { Pool } = await import('pg');
    const owner = new Pool({ connectionString: context.migratorUrl });
    const tables = await owner.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'planning'
       ORDER BY table_name`,
    );

    expect(tables.rows.map((row) => row.table_name)).toEqual(expect.arrayContaining([
      'budget_scopes',
      'budget_categories',
      'budget_versions',
      'budget_allocations',
      'budget_category_account_mappings',
      'recurring_obligations',
      'obligation_occurrences',
      'savings_goals',
      'savings_goal_accounts',
      'virtual_allocations',
      'loan_agreements',
      'debt_plans',
      'domain_audit_records',
    ]));

    const permissions = await owner.query<{ query_budget: boolean; planning_budget: boolean }>(
      `SELECT
        has_table_privilege('plus_one_query','planning.budget_versions','SELECT') AS query_budget,
        has_table_privilege('plus_one_planning','planning.budget_versions','SELECT') AS planning_budget`,
    );

    expect(permissions.rows[0]).toEqual({ query_budget: false, planning_budget: true });
    await owner.end();
  });
});
