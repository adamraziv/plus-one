import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabasePools, createDatabasePools, verifyDatabasePools } from '@plus-one/database';
import { Pool } from 'pg';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;

afterEach(async () => {
  await context?.cleanup();
  context = undefined;
});

describe('database roles and privileges', () => {
  it('makes the owner non-login and every application role non-owner and non-superuser', async () => {
    context = await createPostgresTestContext('role_attributes');
    const pool = new Pool({ connectionString: context.migratorUrl });
    const result = await pool.query<{
      rolname: string;
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
    }>(
      "SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolinherit FROM pg_roles WHERE rolname LIKE 'plus_one_%' AND rolname <> 'plus_one_admin' ORDER BY rolname",
    );

    expect(result.rows).toEqual([
      { rolname: 'plus_one_accounting', rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolinherit: true },
      { rolname: 'plus_one_maintenance', rolcanlogin: false, rolsuper: false, rolcreaterole: false, rolinherit: true },
      { rolname: 'plus_one_memory', rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolinherit: true },
      { rolname: 'plus_one_migrator', rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolinherit: false },
      { rolname: 'plus_one_operations', rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolinherit: true },
      { rolname: 'plus_one_owner', rolcanlogin: false, rolsuper: false, rolcreaterole: false, rolinherit: false },
      { rolname: 'plus_one_planning', rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolinherit: true },
      { rolname: 'plus_one_query', rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolinherit: true },
    ]);

    const ownerMembership = await pool.query<{ migrator_member: boolean; query_member: boolean }>(
      "SELECT pg_has_role('plus_one_migrator', 'plus_one_owner', 'MEMBER') AS migrator_member, pg_has_role('plus_one_query', 'plus_one_owner', 'MEMBER') AS query_member",
    );

    expect(ownerMembership.rows[0]).toEqual({ migrator_member: true, query_member: false });

    await pool.end();
  });

  it('assigns every foundation object to plus_one_owner', async () => {
    context = await createPostgresTestContext('object_ownership');
    const pool = new Pool({ connectionString: context.migratorUrl });
    const objects = await pool.query<{ owner_name: string }>(
      "SELECT pg_get_userbyid(nspowner) AS owner_name FROM pg_namespace WHERE nspname = ANY($1::text[]) UNION ALL SELECT tableowner FROM pg_tables WHERE schemaname = 'operations' UNION ALL SELECT sequenceowner FROM pg_sequences WHERE schemaname = 'operations'",
      [['accounting', 'ingestion', 'planning', 'operations', 'reporting', 'mastra_memory']],
    );

    expect(new Set(objects.rows.map((row) => row.owner_name))).toEqual(new Set(['plus_one_owner']));

    await pool.end();
  });

  it('allows operations household writes but denies delete and all base access to query', async () => {
    context = await createPostgresTestContext('role_boundaries');
    const operations = new Pool({ connectionString: context.roleUrls.operations });
    const query = new Pool({ connectionString: context.roleUrls.query });

    await operations.query(
      "INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone) VALUES ('hh_01JNZQ4A9B8C7D6E5F4G3H2J1K', 'USD', 'UTC')",
    );
    await expect(operations.query('DELETE FROM operations.households')).rejects.toMatchObject({ code: '42501' });
    await expect(query.query('SELECT * FROM operations.households')).rejects.toMatchObject({ code: '42501' });
    await expect(query.query('CREATE TABLE reporting.forbidden (id bigint)')).rejects.toMatchObject({
      code: '25006',
    });
    expect(
      (await query.query<{ default_transaction_read_only: string }>('SHOW default_transaction_read_only')).rows[0],
    ).toEqual({ default_transaction_read_only: 'on' });

    await operations.end();
    await query.end();
  });

  it('revokes PUBLIC schema/function access and applies owner default privileges', async () => {
    context = await createPostgresTestContext('default_privileges');
    const migrator = new Pool({ connectionString: context.migratorUrl });
    const publicAccess = await migrator.query<{ schemas_revoked: boolean; functions_revoked: boolean }>(
      "SELECT bool_and(NOT has_schema_privilege('public', schema_name, 'USAGE')) AS schemas_revoked, NOT has_function_privilege('public', 'operations.is_valid_iana_timezone(text)', 'EXECUTE') AS functions_revoked FROM unnest(ARRAY['accounting','ingestion','planning','operations','reporting','mastra_memory']) AS schema_name",
    );

    expect(publicAccess.rows[0]).toEqual({ schemas_revoked: true, functions_revoked: true });

    await migrator.query('BEGIN');
    await migrator.query('SET LOCAL ROLE plus_one_owner');
    await migrator.query(
      'CREATE TABLE operations.default_privilege_probe (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY)',
    );
    await migrator.query(
      "CREATE FUNCTION operations.default_privilege_probe() RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 1'",
    );
    await migrator.query('COMMIT');

    const defaults = await migrator.query<{ operations_table: boolean; public_function: boolean }>(
      "SELECT has_table_privilege('plus_one_operations', 'operations.default_privilege_probe', 'SELECT,INSERT,UPDATE') AS operations_table, has_function_privilege('public', 'operations.default_privilege_probe()', 'EXECUTE') AS public_function",
    );

    expect(defaults.rows[0]).toEqual({ operations_table: true, public_function: false });

    await migrator.end();
  });

  it('connects each application pool with its exact role identity', async () => {
    context = await createPostgresTestContext('pool_roles');
    const pools = createDatabasePools(context.roleUrls);

    await expect(verifyDatabasePools(pools)).resolves.toBeUndefined();
    await closeDatabasePools(pools);
  });
});
