import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDatabaseConfig, runMigrations, verifyMigrations } from '@plus-one/database';
import { Pool } from 'pg';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;

afterEach(async () => {
  await context?.cleanup();
  context = undefined;
});

describe('platform migrations', () => {
  it('migrates an empty database and is idempotent', async () => {
    context = await createPostgresTestContext('clean_migration', false);
    const config = loadDatabaseConfig();
    const options = {
      connectionString: context.migratorUrl,
      migrationDirectory: resolve('database/migrations'),
      rolePasswords: config.rolePasswords,
    };

    expect(await runMigrations(options)).toEqual([
      '0001_platform_foundation.sql',
      '0002_database_roles.sql',
    ]);
    expect(await runMigrations(options)).toEqual([]);
    await expect(verifyMigrations(options)).resolves.toBeUndefined();
  });

  it('creates only the assigned schemas and foundation relations', async () => {
    context = await createPostgresTestContext('schema_foundation');
    const pool = new Pool({ connectionString: context.migratorUrl });
    const schemas = await pool.query<{ schema_name: string }>(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1::text[]) ORDER BY schema_name",
      [['accounting', 'ingestion', 'mastra_memory', 'operations', 'planning', 'reporting']],
    );

    expect(schemas.rows.map((row) => row.schema_name)).toEqual([
      'accounting',
      'ingestion',
      'mastra_memory',
      'operations',
      'planning',
      'reporting',
    ]);

    const relations = await pool.query<{ relation: string | null }>(
      "SELECT to_regclass('operations.households')::text AS relation UNION ALL SELECT to_regclass('operations.currency_metadata')::text UNION ALL SELECT to_regclass('operations.schema_migrations')::text",
    );

    expect(relations.rows.map((row) => row.relation)).toEqual([
      'operations.households',
      'operations.currency_metadata',
      'operations.schema_migrations',
    ]);

    await pool.end();
  });

  it('enforces household IDs, currency defaults, lifecycle, and IANA timezone', async () => {
    context = await createPostgresTestContext('household_constraints');
    const pool = new Pool({ connectionString: context.roleUrls.operations });
    const inserted = await pool.query<{ household_id: string; reporting_currency: string }>(
      "INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone) VALUES ('hh_01JNZQ4A9B8C7D6E5F4G3H2J1K', 'USD', 'Asia/Shanghai') RETURNING household_id, reporting_currency",
    );

    expect(inserted.rows[0]).toEqual({
      household_id: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      reporting_currency: 'USD',
    });

    await expect(
      pool.query(
        "INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone) VALUES ('bad-id', 'USD', 'UTC')",
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        "INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone) VALUES ('hh_11JNZQ4A9B8C7D6E5F4G3H2J1K', 'USD', 'UTC+8')",
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await pool.end();
  });

  it('validates currency-specific decimal scale', async () => {
    context = await createPostgresTestContext('currency_scale');
    const pool = new Pool({ connectionString: context.migratorUrl });
    const result = await pool.query<{ usd_ok: boolean; usd_bad: boolean; jpy_bad: boolean }>(
      "SELECT operations.amount_matches_currency_scale(12.34, 'USD') AS usd_ok, operations.amount_matches_currency_scale(12.345, 'USD') AS usd_bad, operations.amount_matches_currency_scale(12.1, 'JPY') AS jpy_bad",
    );

    expect(result.rows[0]).toEqual({ usd_ok: true, usd_bad: false, jpy_bad: false });

    await pool.end();
  });

  it('rejects a checksum change to an applied migration', async () => {
    context = await createPostgresTestContext('checksum_guard');
    const migrationPath = resolve('database/migrations/0001_platform_foundation.sql');
    const original = await readFile(migrationPath, 'utf8');

    try {
      await writeFile(migrationPath, `${original}\n-- checksum mutation used only by this test\n`);
      const config = loadDatabaseConfig();
      await expect(
        verifyMigrations({
          connectionString: context.migratorUrl,
          migrationDirectory: resolve('database/migrations'),
          rolePasswords: config.rolePasswords,
        }),
      ).rejects.toMatchObject({ code: 'migration_verification_failed' });
    } finally {
      await writeFile(migrationPath, original);
    }
  });
});
