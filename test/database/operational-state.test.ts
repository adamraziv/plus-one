import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;

afterEach(async () => {
  await context?.cleanup();
  context = undefined;
});

async function seedHousehold(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ('hh_01JNZQ4A9B8C7D6E5F4G3H2J1K', 'USD', 'UTC')`,
  );
}

async function seedTask(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO operations.verification_tasks
     (task_id, household_id, team, status, attempt_limit)
     SELECT 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K', id, 'query', 'created', 2
     FROM operations.households WHERE household_id = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K'`,
  );
}

describe('operational verification persistence', () => {
  it('creates only the minimal verification-ledger relations', async () => {
    context = await createPostgresTestContext('operational_relations');
    const pool = new Pool({ connectionString: context.migratorUrl });
    try {
      const result = await pool.query<{ relation: string }>(
        `SELECT table_name AS relation FROM information_schema.tables
         WHERE table_schema = 'operations' AND table_name = ANY($1::text[]) ORDER BY table_name`,
        [[
          'agent_attempts',
          'agent_runs',
          'artifacts',
          'checker_verdicts',
          'task_transitions',
          'verification_tasks',
        ]],
      );

      expect(result.rows.map((row) => row.relation)).toEqual([
        'agent_attempts',
        'agent_runs',
        'artifacts',
        'checker_verdicts',
        'task_transitions',
        'verification_tasks',
      ]);
    } finally {
      await pool.end();
    }
  });

  it('makes artifacts and accepted transitions append-only', async () => {
    context = await createPostgresTestContext('operational_immutability');
    const pool = new Pool({ connectionString: context.roleUrls.operations });
    try {
      await seedHousehold(pool);
      await seedTask(pool);
      await pool.query(
        `INSERT INTO operations.artifacts
         (artifact_id, household_id, task_id, artifact_type, schema_name, schema_version,
          canonicalization_version, hash_algorithm, artifact_hash, canonical_payload, payload)
         SELECT 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K', id, 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
          'maker_output', 'test-maker', 1, 'rfc8785-v1', 'sha256', repeat('a', 64), '{}', '{}'::jsonb
         FROM operations.households LIMIT 1`,
      );
      await expect(
        pool.query("UPDATE operations.artifacts SET artifact_hash = repeat('b', 64)"),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(pool.query('DELETE FROM operations.artifacts')).rejects.toMatchObject({
        code: '55000',
      });
    } finally {
      await pool.end();
    }
  });

  it('denies verification-ledger access to query, accounting, and planning roles', async () => {
    context = await createPostgresTestContext('operational_permissions');
    for (const role of ['query', 'accounting', 'planning'] as const) {
      const pool = new Pool({ connectionString: context.roleUrls[role] });
      await expect(
        pool.query('SELECT * FROM operations.verification_tasks'),
      ).rejects.toMatchObject({ code: '42501' });
      await pool.end();
    }
  });
});
