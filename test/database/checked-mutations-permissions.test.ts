import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;

afterEach(async () => {
  await context?.cleanup();
  context = undefined;
});

describe('checked mutation permissions', () => {
  it('keeps receipts function-only and operations state hidden from domain/query roles', async () => {
    context = await createPostgresTestContext('mutation_permissions');
    const admin = new Pool({ connectionString: context.migratorUrl });
    const result = await admin.query<{
      operations_insert_command: boolean;
      operations_insert_receipt: boolean;
      operations_update_readback: boolean;
      accounting_select_command: boolean;
      accounting_claim: boolean;
      query_select_receipt: boolean;
      public_claim: boolean;
    }>(`SELECT
      has_table_privilege('plus_one_operations','operations.mutation_commands','INSERT')
        AS operations_insert_command,
      has_table_privilege('plus_one_operations','operations.mutation_receipts','INSERT')
        AS operations_insert_receipt,
      has_table_privilege('plus_one_operations','operations.mutation_readbacks','UPDATE')
        AS operations_update_readback,
      has_table_privilege('plus_one_accounting','operations.mutation_commands','SELECT')
        AS accounting_select_command,
      has_function_privilege('plus_one_accounting',
        'operations.claim_mutation_command(text,text)','EXECUTE') AS accounting_claim,
      has_function_privilege('plus_one_planning',
        'operations.claim_mutation_command(text,text)','EXECUTE') AS planning_claim,
      has_table_privilege('plus_one_query','operations.mutation_receipts','SELECT')
        AS query_select_receipt,
      EXISTS (
        SELECT 1 FROM information_schema.routine_privileges privilege
        WHERE privilege.routine_schema = 'operations'
          AND privilege.routine_name = 'claim_mutation_command'
          AND privilege.grantee = 'PUBLIC' AND privilege.privilege_type = 'EXECUTE'
      ) AS public_claim`);
    expect(result.rows[0]).toEqual({
      operations_insert_command: true,
      operations_insert_receipt: false,
      operations_update_readback: false,
      accounting_select_command: false,
      accounting_claim: true,
      planning_claim: true,
      query_select_receipt: false,
      public_claim: false,
    });
    await admin.end();
  });

  it('uses owner-controlled security-definer functions with fixed search paths', async () => {
    context = await createPostgresTestContext('mutation_function_security');
    const admin = new Pool({ connectionString: context.migratorUrl });
    const result = await admin.query<{
      proname: string;
      prosecdef: boolean;
      owner: string;
      config: string[];
    }>(
      `SELECT procedure.proname, procedure.prosecdef,
        pg_get_userbyid(procedure.proowner) AS owner,
        coalesce(procedure.proconfig, '{}') AS config
       FROM pg_proc procedure
       JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
       WHERE namespace.nspname = 'operations'
         AND procedure.proname IN ('claim_mutation_command','commit_mutation_command')
       ORDER BY procedure.proname`,
    );
    expect(result.rows).toEqual([
      {
        proname: 'claim_mutation_command',
        prosecdef: true,
        owner: 'plus_one_owner',
        config: ['search_path=pg_catalog, operations'],
      },
      {
        proname: 'commit_mutation_command',
        prosecdef: true,
        owner: 'plus_one_owner',
        config: ['search_path=pg_catalog, operations'],
      },
    ]);
    await admin.end();
  });
});
