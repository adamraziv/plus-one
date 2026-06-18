// test/database/accounting-ledger-permissions.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;
afterEach(async () => { await context?.cleanup(); context = undefined; });

describe('accounting ledger permissions', () => {
  it('gives the accounting command role only scoped reference and append privileges', async () => {
    context = await createPostgresTestContext('accounting_permissions');
    const admin = new Pool({ connectionString: context.migratorUrl });
    const privileges = await admin.query<{
      accounting_insert: boolean; accounting_update_postings: boolean;
      accounting_delete_journals: boolean; query_select: boolean;
      operations_select_artifacts: boolean; household_lookup: boolean;
      mapping_insert: boolean; mapping_delete: boolean;
    }>(`SELECT
      has_table_privilege('plus_one_accounting','accounting.journals','INSERT') AS accounting_insert,
      has_table_privilege('plus_one_accounting','accounting.postings','UPDATE') AS accounting_update_postings,
      has_table_privilege('plus_one_accounting','accounting.journals','DELETE') AS accounting_delete_journals,
      has_table_privilege('plus_one_query','accounting.journals','SELECT') AS query_select,
      has_table_privilege('plus_one_accounting','operations.artifacts','SELECT') AS operations_select_artifacts,
      has_table_privilege('plus_one_accounting','operations.households','SELECT') AS household_lookup,
      has_table_privilege('plus_one_accounting','accounting.account_source_mappings','INSERT') AS mapping_insert,
      has_table_privilege('plus_one_accounting','accounting.account_source_mappings','DELETE') AS mapping_delete`);
    expect(privileges.rows[0]).toEqual({
      accounting_insert: true, accounting_update_postings: false,
      accounting_delete_journals: false, query_select: false,
      operations_select_artifacts: false, household_lookup: true,
      mapping_insert: true, mapping_delete: false,
    });
    await admin.end();
  });

  it('rejects update, delete, truncate, and base-table reads from non-accounting roles', async () => {
    context = await createPostgresTestContext('accounting_permission_denials');
    const accounting = new Pool({ connectionString: context.roleUrls.accounting });
    const query = new Pool({ connectionString: context.roleUrls.query });
    const operations = new Pool({ connectionString: context.roleUrls.operations });
    await expect(accounting.query('TRUNCATE accounting.journals')).rejects.toMatchObject({ code: '42501' });
    await expect(query.query('SELECT * FROM accounting.journals')).rejects.toMatchObject({ code: '42501' });
    await expect(operations.query('SELECT * FROM accounting.accounts')).rejects.toMatchObject({ code: '42501' });
    await accounting.end(); await query.end(); await operations.end();
  });
});
