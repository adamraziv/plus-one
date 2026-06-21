import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext;
let owner: Pool;
let query: Pool;

beforeAll(async () => {
  context = await createPostgresTestContext('query_role');
  owner = new Pool({ connectionString: context.migratorUrl });
  query = new Pool({ connectionString: context.roleUrls.query });
});

afterAll(async () => {
  await query.end();
  await owner.end();
  await context.cleanup();
});

describe('query role permissions', () => {
  it('applies the Plan 10 migration and grants only reporting reads', async () => {
    const migration = await owner.query<{ filename: string }>(
      "SELECT filename FROM operations.schema_migrations WHERE filename='0010_query_role.sql'",
    );
    expect(migration.rows.map((row) => row.filename)).toEqual(['0010_query_role.sql']);

    const reportingRelations = await owner.query<{ relation_name: string }>(
      'SELECT relation_name FROM reporting.relation_metadata ORDER BY relation_name',
    );
    for (const { relation_name: relationName } of reportingRelations.rows) {
      const privilege = await owner.query<{ allowed: boolean }>(
        'SELECT has_table_privilege($1, $2, $3) AS allowed',
        ['plus_one_query', relationName, 'SELECT'],
      );
      expect(privilege.rows[0]?.allowed).toBe(true);
    }

    const denied = await owner.query<{
      accounting: boolean;
      planning: boolean;
      ingestion: boolean;
      operations: boolean;
      memory: boolean;
      sequence_usage: boolean;
    }>(
      `SELECT
        has_table_privilege('plus_one_query','accounting.accounts','SELECT') AS accounting,
        has_table_privilege('plus_one_query','planning.budget_versions','SELECT') AS planning,
        has_table_privilege('plus_one_query','ingestion.source_documents','SELECT') AS ingestion,
        has_table_privilege('plus_one_query','operations.verification_tasks','SELECT') AS operations,
        has_schema_privilege('plus_one_query','mastra_memory','USAGE') AS memory,
        has_sequence_privilege('plus_one_query','reporting.projection_health_id_seq','USAGE') AS sequence_usage`,
    );
    expect(denied.rows[0]).toEqual({
      accounting: false,
      planning: false,
      ingestion: false,
      operations: false,
      memory: false,
      sequence_usage: false,
    });
  });

  it('executes as read-only over reporting relations', async () => {
    await expect(query.query('SELECT count(*) FROM reporting.accounts')).resolves.toBeDefined();
    await expect(query.query('INSERT INTO reporting.projection_health(household_id, projection_key, status) VALUES (1, $1, $2)',
      ['current_balances', 'healthy'])).rejects.toThrow();
    await expect(query.query('SELECT count(*) FROM accounting.accounts')).rejects.toThrow();
  });
});
