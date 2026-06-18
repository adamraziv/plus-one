import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Pool, type PoolClient } from 'pg';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;
afterEach(async () => { await context?.cleanup(); context = undefined; });

interface SeededLedger {
  householdId: string; householdDbId: string; bookDbId: string; periodDbId: string;
  cashAccountDbId: string; expenseAccountDbId: string; draftDbId: string;
}

async function seedCheckedDraft(client: PoolClient, debitAmount = '20.00',
  creditAmount = debitAmount): Promise<SeededLedger> {
  const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
  const household = await client.query<{ id: string }>(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1, 'USD', 'UTC') RETURNING id::text`, [householdId],
  );
  const householdDbId = household.rows[0]!.id;
  const book = await client.query<{ id: string }>(
    `INSERT INTO accounting.books (book_id, household_id, name)
     VALUES ('book_01JNZQ4A9B8C7D6E5F4G3H2J1K', $1, 'Household Book') RETURNING id::text`,
    [householdDbId],
  );
  const bookDbId = book.rows[0]!.id;
  await client.query(
    `INSERT INTO accounting.book_configurations
     (configuration_id, household_id, book_id, reporting_currency, effective_from)
     VALUES ('bookconfig_01JNZQ4A9B8C7D6E5F4G3H2J1K', $1, $2, 'USD', DATE '2026-01-01')`,
    [householdDbId, bookDbId],
  );
  const period = await client.query<{ id: string }>(
    `INSERT INTO accounting.periods
     (period_id, household_id, book_id, period_start, period_end)
     VALUES ('period_01JNZQ4A9B8C7D6E5F4G3H2J1K', $1, $2,
             DATE '2026-06-01', DATE '2026-06-30') RETURNING id::text`,
    [householdDbId, bookDbId],
  );
  const accounts = await client.query<{ id: string; account_id: string }>(
    `INSERT INTO accounting.accounts
     (account_id, household_id, book_id, name, accounting_class, normal_balance, native_currency)
     VALUES
     ('account_01JNZQ4A9B8C7D6E5F4G3H2J1K', $1, $2, 'Cash', 'asset', 'debit', 'USD'),
     ('account_01JNZQ4A9B8C7D6E5F4G3H2J2K', $1, $2, 'Food', 'expense', 'debit', 'USD')
     RETURNING id::text, account_id`,
    [householdDbId, bookDbId],
  );
  await client.query(
    `INSERT INTO operations.verification_tasks
     (task_id, household_id, team, status, attempt_limit, resumable)
     VALUES ('task_01JNZQ4A9B8C7D6E5F4G3H2J1K', $1, 'accounting', 'checker_validated', 2, false)`,
    [householdDbId],
  );
  await client.query(
    `INSERT INTO operations.artifacts
     (artifact_id, household_id, task_id, artifact_type, schema_name, schema_version,
      canonicalization_version, hash_algorithm, artifact_hash, canonical_payload, payload)
     VALUES
     ('artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K', $1, 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      'maker_output', 'journal-draft-input', 1, 'rfc8785-v1', 'sha256', $2, '{}', '{}'),
     ('artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K', $1, 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      'checker_output', 'checker-verdict', 1, 'rfc8785-v1', 'sha256', $3, '{}', '{}')`,
    [householdDbId, 'a'.repeat(64), 'b'.repeat(64)],
  );
  await client.query(
    `INSERT INTO operations.checker_verdicts
     (household_id, task_id, checker_artifact_id, covered_artifact_id, covered_artifact_hash, verdict)
     VALUES ($1, 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
       'artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K',
       'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K', $2, 'accepted')`,
    [householdDbId, 'a'.repeat(64)],
  );
  const draft = await client.query<{ id: string }>(
    `INSERT INTO accounting.journal_drafts
     (draft_id, draft_series_id, version, household_id, book_id, task_id,
      checked_artifact_id, checked_artifact_hash, journal_type, transaction_currency,
      occurred_on, effective_on, description)
     VALUES ('draft_01JNZQ4A9B8C7D6E5F4G3H2J1K',
       'draftseries_01JNZQ4A9B8C7D6E5F4G3H2J1K', 1, $1, $2,
       'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
       'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K', $3, 'ordinary', 'USD',
       DATE '2026-06-14', DATE '2026-06-14', 'Burger') RETURNING id::text`,
    [householdDbId, bookDbId, 'a'.repeat(64)],
  );
  const byPublic = new Map(accounts.rows.map((row) => [row.account_id, row.id]));
  await client.query(
    `INSERT INTO accounting.draft_postings
     (household_id, draft_id, ordinal, account_id, direction, transaction_amount,
      account_native_amount, account_native_currency)
     VALUES
     ($1, $2, 1, $3, 'debit', $4, $4, 'USD'),
     ($1, $2, 2, $5, 'credit', $6, $6, 'USD')`,
    [householdDbId, draft.rows[0]!.id,
      byPublic.get('account_01JNZQ4A9B8C7D6E5F4G3H2J2K')!, debitAmount,
      byPublic.get('account_01JNZQ4A9B8C7D6E5F4G3H2J1K')!, creditAmount],
  );
  return {
    householdId, householdDbId, bookDbId, periodDbId: period.rows[0]!.id,
    cashAccountDbId: byPublic.get('account_01JNZQ4A9B8C7D6E5F4G3H2J1K')!,
    expenseAccountDbId: byPublic.get('account_01JNZQ4A9B8C7D6E5F4G3H2J2K')!,
    draftDbId: draft.rows[0]!.id,
  };
}

async function insertJournal(client: PoolClient, seed: SeededLedger, amount: string, creditAmount = amount) {
  const journal = await client.query<{ id: string }>(
    `INSERT INTO accounting.journals
     (journal_id, household_id, book_id, period_id, draft_id, task_id,
      checked_artifact_id, checked_artifact_hash, journal_type, transaction_currency,
      occurred_on, effective_on, description)
     VALUES ('journal_01JNZQ4A9B8C7D6E5F4G3H2J1K', $1, $2, $3, $4,
       'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
       'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K', $5, 'ordinary', 'USD',
       DATE '2026-06-14', DATE '2026-06-14', 'Burger') RETURNING id::text`,
    [seed.householdDbId, seed.bookDbId, seed.periodDbId, seed.draftDbId, 'a'.repeat(64)],
  );
  await client.query(
    `INSERT INTO accounting.postings
     (posting_id, household_id, journal_id, ordinal, account_id, direction,
      transaction_amount, account_native_amount, account_native_currency)
     VALUES
     ('posting_01JNZQ4A9B8C7D6E5F4G3H2J1K', $1, $2, 1, $3, 'debit', $4, $4, 'USD'),
     ('posting_01JNZQ4A9B8C7D6E5F4G3H2J2K', $1, $2, 2, $5, 'credit', $6, $6, 'USD')`,
    [seed.householdDbId, journal.rows[0]!.id, seed.expenseAccountDbId,
      amount, seed.cashAccountDbId, creditAmount],
  );
}

describe('accounting commit-time integrity', () => {
  it('accepts a complete balanced checked journal and rejects later mutation', async () => {
    context = await createPostgresTestContext('accounting_balanced');
    const pool = new Pool({ connectionString: context.migratorUrl });
    const client = await pool.connect();
    await client.query('BEGIN');
    const seed = await seedCheckedDraft(client);
    await insertJournal(client, seed, '20.00');
    await client.query('COMMIT');
    await expect(pool.query(
      "UPDATE accounting.postings SET transaction_amount = 25 WHERE posting_id = 'posting_01JNZQ4A9B8C7D6E5F4G3H2J1K'",
    )).rejects.toMatchObject({ code: '55000' });
    client.release();
    await pool.end();
  });

  it('rejects an unbalanced journal only when deferred constraints are checked', async () => {
    context = await createPostgresTestContext('accounting_unbalanced');
    const pool = new Pool({ connectionString: context.migratorUrl });
    const client = await pool.connect();
    await client.query('BEGIN');
    const seed = await seedCheckedDraft(client, '20.00', '19.99');
    await insertJournal(client, seed, '20.00', '19.99');
    await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toMatchObject({ code: '23514' });
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  });

  it('property-checks balanced and unbalanced two-sided journals against PostgreSQL', async () => {
    context = await createPostgresTestContext('accounting_property');
    const pool = new Pool({ connectionString: context.migratorUrl });
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 999_999 }),
      fc.boolean(),
      async (cents, shouldBalance) => {
        await pool.query('TRUNCATE operations.households CASCADE');
        const client = await pool.connect();
        await client.query('BEGIN');
        const amount = (cents / 100).toFixed(2);
        const credit = shouldBalance ? amount : ((cents + 1) / 100).toFixed(2);
        const seed = await seedCheckedDraft(client, amount, credit);
        await insertJournal(client, seed, amount, credit);
        const result = await client.query('SAVEPOINT before_constraints')
          .then(() => client.query('SET CONSTRAINTS ALL IMMEDIATE'))
          .then(() => true, () => false);
        expect(result).toBe(shouldBalance);
        await client.query('ROLLBACK');
        client.release();
      },
    ), { numRuns: 25 });
    await pool.end();
  });
});
