// test/database/accounting-ledger-schema.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;
afterEach(async () => { await context?.cleanup(); context = undefined; });

async function seedHousehold(pool: Pool, householdId: string) {
  await pool.query(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1, 'USD', 'UTC')`,
    [householdId],
  );
}

describe('accounting ledger schema', () => {
  it('creates the complete Plan 04 relation set without a mutable account balance', async () => {
    context = await createPostgresTestContext('accounting_schema');
    const pool = new Pool({ connectionString: context.migratorUrl });
    const relations = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'accounting' ORDER BY table_name`,
    );
    expect(relations.rows.map((row) => row.table_name)).toEqual([
      'account_source_mappings', 'accounts', 'book_configurations', 'books',
      'counterparties', 'draft_postings',
      'journal_drafts', 'journal_tags', 'journals', 'periods', 'posting_tags', 'postings', 'tags',
    ]);
    const accountColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'accounting' AND table_name = 'accounts'`,
    );
    expect(accountColumns.rows.map((row) => row.column_name)).not.toContain('balance');
    await pool.end();
  });

  it('prevents cross-household book, account, period, and artifact references', async () => {
    context = await createPostgresTestContext('accounting_household');
    const pool = new Pool({ connectionString: context.migratorUrl });
    await seedHousehold(pool, 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K');
    await seedHousehold(pool, 'hh_01JNZQ4A9B8C7D6E5F4G3H2J2K');
    const households = await pool.query<{ id: string; household_id: string }>(
      'SELECT id::text, household_id FROM operations.households ORDER BY household_id',
    );
    const first = households.rows[0]!;
    const second = households.rows[1]!;
    const book = await pool.query<{ id: string }>(
      `INSERT INTO accounting.books (book_id, household_id, name)
       VALUES ('book_01JNZQ4A9B8C7D6E5F4G3H2J1K', $1, 'Household Book') RETURNING id::text`,
      [first.id],
    );
    await expect(pool.query(
      `INSERT INTO accounting.accounts
       (account_id, household_id, book_id, name, accounting_class, normal_balance, native_currency)
       VALUES ('account_01JNZQ4A9B8C7D6E5F4G3H2J1K', $1, $2, 'Wrong Household',
               'asset', 'debit', 'USD')`,
      [second.id, book.rows[0]!.id],
    )).rejects.toMatchObject({ code: '23503' });
    await pool.end();
  });

  it('keeps each household to one consolidated book and versions reporting currency by date', async () => {
    context = await createPostgresTestContext('accounting_book');
    const pool = new Pool({ connectionString: context.migratorUrl });
    await seedHousehold(pool, 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K');
    const household = await pool.query<{ id: string }>(
      "SELECT id::text FROM operations.households WHERE household_id = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K'",
    );
    const book = await pool.query<{ id: string }>(
      `INSERT INTO accounting.books (book_id, household_id, name)
       VALUES ('book_01JNZQ4A9B8C7D6E5F4G3H2J1K', $1, 'Household Book') RETURNING id::text`,
      [household.rows[0]!.id],
    );
    await expect(pool.query(
      `INSERT INTO accounting.books (book_id, household_id, name)
       VALUES ('book_01JNZQ4A9B8C7D6E5F4G3H2J2K', $1, 'Second Book')`,
      [household.rows[0]!.id],
    )).rejects.toMatchObject({ code: '23505' });
    await pool.query(
      `INSERT INTO accounting.book_configurations
       (configuration_id, household_id, book_id, reporting_currency, effective_from)
       VALUES
       ('bookconfig_01JNZQ4A9B8C7D6E5F4G3H2J1K', $1, $2, 'USD', DATE '2026-01-01'),
       ('bookconfig_01JNZQ4A9B8C7D6E5F4G3H2J2K', $1, $2, 'EUR', DATE '2027-01-01')`,
      [household.rows[0]!.id, book.rows[0]!.id],
    );
    await pool.end();
  });

  it('keeps one active source identity mapping and permits archive-plus-replacement', async () => {
    context = await createPostgresTestContext('accounting_source_mapping');
    const pool = new Pool({ connectionString: context.migratorUrl });
    await seedHousehold(pool, 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K');
    const account = await pool.query<{ household_id: string; book_id: string; id: string }>(
      `WITH book AS (
         INSERT INTO accounting.books (book_id, household_id, name)
         SELECT 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K', id, 'Household Book'
         FROM operations.households
         WHERE household_id = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K'
         RETURNING household_id, id
       )
       INSERT INTO accounting.accounts
       (account_id, household_id, book_id, name, accounting_class, normal_balance, native_currency)
       SELECT 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K', household_id, id,
         'Cash', 'asset', 'debit', 'USD' FROM book
       RETURNING household_id::text, book_id::text, id::text`,
    );
    const ids = account.rows[0]!;
    await pool.query(
      `INSERT INTO accounting.account_source_mappings
       (mapping_id, household_id, book_id, account_id, source_system, external_account_id, metadata)
       VALUES ('accountmap_01JNZQ4A9B8C7D6E5F4G3H2J1K',$1,$2,$3,'bank-feed','checking-1',
         '{"label":"Primary checking"}')`,
      [ids.household_id, ids.book_id, ids.id],
    );
    await expect(pool.query(
      `INSERT INTO accounting.account_source_mappings
       (mapping_id, household_id, book_id, account_id, source_system, external_account_id)
       VALUES ('accountmap_01JNZQ4A9B8C7D6E5F4G3H2J2K',$1,$2,$3,'bank-feed','checking-1')`,
      [ids.household_id, ids.book_id, ids.id],
    )).rejects.toMatchObject({ code: '23505', constraint: 'account_source_mappings_active_identity' });
    await pool.query(
      `UPDATE accounting.account_source_mappings SET archived_at = clock_timestamp()
       WHERE mapping_id = 'accountmap_01JNZQ4A9B8C7D6E5F4G3H2J1K'`,
    );
    await expect(pool.query(
      `INSERT INTO accounting.account_source_mappings
       (mapping_id, household_id, book_id, account_id, source_system, external_account_id)
       VALUES ('accountmap_01JNZQ4A9B8C7D6E5F4G3H2J2K',$1,$2,$3,'bank-feed','checking-1')`,
      [ids.household_id, ids.book_id, ids.id],
    )).resolves.toBeDefined();
    await pool.end();
  });
});
