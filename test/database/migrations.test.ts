import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
      '0003_operational_verification.sql',
      '0004_accounting_ledger.sql',
      '0005_checked_mutations.sql',
      '0006_ingestion_reconciliation.sql',
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

  it('rolls back all statements when a migration fails before recording its checksum', async () => {
    context = await createPostgresTestContext('migration_rollback', false);
    const directory = await mkdtemp(resolve(tmpdir(), 'plus-one-migration-rollback-'));
    const config = loadDatabaseConfig();

    try {
      await writeFile(
        resolve(directory, '0001_failing_migration.sql'),
        `
CREATE SCHEMA operations;
CREATE TABLE operations.schema_migrations (
  filename text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer NOT NULL CHECK (duration_ms >= 0)
);
CREATE TABLE operations.rollback_probe (id bigint PRIMARY KEY);
SELECT 1 / 0;
`,
      );

      await expect(
        runMigrations({
          connectionString: context.migratorUrl,
          migrationDirectory: directory,
          rolePasswords: config.rolePasswords,
        }),
      ).rejects.toMatchObject({ code: 'database_constraint_violation' });

      const pool = new Pool({ connectionString: context.migratorUrl });

      try {
        const result = await pool.query<{ probe_relation: string | null }>(
          "SELECT to_regclass('operations.rollback_probe')::text AS probe_relation",
        );

        expect(result.rows[0]).toEqual({ probe_relation: null });
      } finally {
        await pool.end();
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('re-hardens an existing application role when migrations can manage roles', async () => {
    context = await createPostgresTestContext('reharden_roles', false);
    const config = loadDatabaseConfig();

    if (config.adminUrl === undefined) {
      throw new Error('DATABASE_ADMIN_URL is required for database tests');
    }

    const admin = new Pool({ connectionString: config.adminUrl, max: 1 });

    try {
      await admin.query(`
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plus_one_accounting') THEN
    CREATE ROLE plus_one_accounting LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS PASSWORD 'temporary_plus_one_accounting_password';
  END IF;
END
$$;
`);
      await admin.query('ALTER ROLE plus_one_migrator CREATEDB CREATEROLE INHERIT');
      await admin.query('GRANT plus_one_accounting TO plus_one_migrator WITH ADMIN TRUE');
      await admin.query('ALTER ROLE plus_one_accounting CREATEDB');

      await runMigrations({
        connectionString: context.migratorUrl,
        migrationDirectory: resolve('database/migrations'),
        rolePasswords: config.rolePasswords,
      });

      const result = await admin.query<{ rolcreatedb: boolean }>(
        "SELECT rolcreatedb FROM pg_roles WHERE rolname = 'plus_one_accounting'",
      );

      expect(result.rows[0]).toEqual({ rolcreatedb: false });
    } finally {
      await admin.query('ALTER ROLE plus_one_accounting NOCREATEDB NOCREATEROLE NOBYPASSRLS');
      await admin.query('ALTER ROLE plus_one_migrator NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS');
      await admin.end();
    }
  });
});
