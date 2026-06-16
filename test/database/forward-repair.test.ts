import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDatabaseConfig } from '@plus-one/database';
import { Pool } from 'pg';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;

afterEach(async () => {
  await context?.cleanup();
  context = undefined;
});

function databaseUrl(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

describe('database forward repair', () => {
  it('restores role privileges and reports machine-readable verification after privilege drift', async () => {
    context = await createPostgresTestContext('forward_repair');
    const config = loadDatabaseConfig();

    if (config.adminUrl === undefined) {
      throw new Error('DATABASE_ADMIN_URL is required for forward repair tests');
    }

    const admin = new Pool({ connectionString: databaseUrl(config.adminUrl, context.databaseName), max: 1 });
    const operations = new Pool({ connectionString: context.roleUrls.operations, max: 1 });
    const query = new Pool({ connectionString: context.roleUrls.query, max: 1 });
    const repairSql = await readFile(resolve('database/repair/0002_restore_database_roles.sql'), 'utf8');
    const verifySql = await readFile(resolve('database/repair/0002_restore_database_roles.verify.sql'), 'utf8');

    try {
      await admin.query('GRANT USAGE ON SCHEMA operations TO PUBLIC');
      await admin.query('GRANT SELECT ON operations.households TO plus_one_query');
      await admin.query('REVOKE INSERT, UPDATE ON operations.households FROM plus_one_operations');

      await expect(operations.query(
        "INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone) VALUES ('hh_01JQ1Z8W6A7B9C0D1E2F3G4H5J', 'USD', 'UTC')",
      )).rejects.toMatchObject({ code: '42501' });
      await expect(query.query('SELECT household_id FROM operations.households')).resolves.toBeDefined();
      await expect(admin.query<{
        public_schema_access_revoked: boolean;
        operations_household_access_restored: boolean;
        query_base_access_denied: boolean;
        query_read_only: boolean;
      }>(verifySql)).resolves.toMatchObject({
        rows: [
          {
            public_schema_access_revoked: false,
            operations_household_access_restored: true,
            query_base_access_denied: false,
            query_read_only: true,
          },
        ],
      });

      await admin.query(repairSql);
      await admin.query(repairSql);

      await expect(admin.query(verifySql)).resolves.toMatchObject({
        rows: [
          {
            public_schema_access_revoked: true,
            operations_household_access_restored: true,
            query_base_access_denied: true,
            query_read_only: true,
          },
        ],
      });
      await expect(query.query('SELECT household_id FROM operations.households')).rejects.toMatchObject({ code: '42501' });
      await expect(operations.query(
        "INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone) VALUES ('hh_01JQ1Z8W6A7B9C0D1E2F3G4H5K', 'USD', 'UTC')",
      )).resolves.toBeDefined();
    } finally {
      await operations.end();
      await query.end();
      await admin.end();
    }
  });
});
