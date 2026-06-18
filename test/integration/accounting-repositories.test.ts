import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  AccountingRepository, JournalDraftRepository, assertSerializableTransaction,
} from '@plus-one/accounting';
import type {
  AccountId, ArtifactId, BookId, CurrencyCode, DecimalString, DraftSeriesId, HouseholdId,
  JournalDraftId, LocalDate, TagId, TaskId,
} from '@plus-one/contracts';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;
afterEach(async () => { await context?.cleanup(); context = undefined; });

describe('accounting repositories', () => {
  it('creates a household book, account hierarchy, and monthly period through typed methods', async () => {
    context = await createPostgresTestContext('accounting_repositories');
    const pool = new Pool({ connectionString: context.roleUrls.accounting });
    const owner = new Pool({ connectionString: context.migratorUrl });
    await owner.query(
      `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
       VALUES ('hh_01JNZQ4A9B8C7D6E5F4G3H2J1K', 'USD', 'UTC')`,
    );
    const repository = new AccountingRepository();
    const client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await repository.createBookWithConfiguration(client, {
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      configurationId: 'bookconfig_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      name: 'Household Book', reportingCurrency: 'USD', effectiveFrom: '2026-01-01',
    });
    await repository.createAccount(client, {
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      name: 'Cash', accountingClass: 'asset', normalBalance: 'debit', nativeCurrency: 'USD',
    });
    await repository.updateAccount(client, {
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K', name: 'Primary Cash',
      purpose: 'Daily spending', accountingClass: 'asset', normalBalance: 'debit',
      nativeCurrency: 'USD', ownershipLabel: 'joint',
    });
    await repository.createAccountSourceMapping(client, {
      mappingId: 'accountmap_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      sourceSystem: 'bank-feed', externalAccountId: 'checking-1',
      metadata: { label: 'Primary checking' },
    });
    await repository.archiveAccountSourceMapping(client, {
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      mappingId: 'accountmap_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    });
    await repository.createAccountSourceMapping(client, {
      mappingId: 'accountmap_01JNZQ4A9B8C7D6E5F4G3H2J2K',
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      sourceSystem: 'bank-feed', externalAccountId: 'checking-1',
      metadata: { label: 'Renamed checking' },
    });
    await repository.createPeriod(client, {
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      periodId: 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      periodStart: '2026-06-01', periodEnd: '2026-06-30',
    });
    await client.query('COMMIT');
    const account = await owner.query(
      `SELECT account.name, account.accounting_class, account.native_currency,
        account.purpose, account.ownership_label, mapping.source_system,
        mapping.external_account_id, mapping.metadata
       FROM accounting.accounts account
       JOIN accounting.account_source_mappings mapping ON mapping.account_id = account.id
       WHERE account.account_id = 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K'
         AND mapping.archived_at IS NULL`,
    );
    expect(account.rows[0]).toEqual({
      name: 'Primary Cash', accounting_class: 'asset', native_currency: 'USD',
      purpose: 'Daily spending', ownership_label: 'joint', source_system: 'bank-feed',
      external_account_id: 'checking-1', metadata: { label: 'Renamed checking' },
    });
    client.release();
    await pool.end();
    await owner.end();
  });

  it('rejects posting work outside an existing serializable transaction', async () => {
    context = await createPostgresTestContext('accounting_isolation');
    const pool = new Pool({ connectionString: context.roleUrls.accounting });
    const client = await pool.connect();
    await expect(assertSerializableTransaction(client)).rejects.toMatchObject({
      code: 'serializable_transaction_required',
    });
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await expect(assertSerializableTransaction(client)).resolves.toBeUndefined();
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  });

  it('persists exact consecutive immutable draft versions', async () => {
    context = await createPostgresTestContext('accounting_drafts');
    const owner = new Pool({ connectionString: context.migratorUrl });
    const pool = new Pool({ connectionString: context.roleUrls.accounting });
    await seedDraftPrerequisites(owner);
    const repository = new JournalDraftRepository();
    const client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await repository.insertVersion(client, draftInput(1));
    await repository.insertVersion(client, {
      ...draftInput(2),
      draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J2K' as JournalDraftId,
      previousDraftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J1K' as JournalDraftId,
      description: 'Revised burger',
    });
    await client.query('COMMIT');
    const versions = await owner.query(
      `SELECT version, description FROM accounting.journal_drafts
       ORDER BY version`,
    );
    expect(versions.rows).toEqual([
      { version: 1, description: 'Burger' },
      { version: 2, description: 'Revised burger' },
    ]);
    await expect(repository.insertVersion(client, {
      ...draftInput(3), draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J3K' as JournalDraftId,
      previousDraftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J1K' as JournalDraftId,
    })).rejects.toMatchObject({ category: 'constraint_violation' });
    client.release();
    await pool.end();
    await owner.end();
  });
});

function draftInput(version: number) {
  return {
    schemaName: 'journal-draft-input' as const, schemaVersion: 1 as const,
    householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K' as HouseholdId,
    bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' as BookId,
    draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J1K' as JournalDraftId,
    draftSeriesId: 'draftseries_01JNZQ4A9B8C7D6E5F4G3H2J1K' as DraftSeriesId,
    version,
    taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K' as TaskId,
    checkedArtifactId: (version === 1
      ? 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K'
      : 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J3K') as ArtifactId,
    checkedArtifactHash: (version === 1 ? 'a' : 'c').repeat(64), journalType: 'ordinary' as const,
    transactionCurrency: 'USD' as CurrencyCode, occurredOn: '2026-06-14' as LocalDate,
    effectiveOn: '2026-06-14' as LocalDate,
    description: 'Burger', tagIds: [] as TagId[],
    postings: [
      { accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K' as AccountId, direction: 'debit' as const,
        transactionAmount: '20.00' as DecimalString, accountNativeAmount: '20.00' as DecimalString,
        accountNativeCurrency: 'USD' as CurrencyCode, tagIds: [] as TagId[] },
      { accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K' as AccountId, direction: 'credit' as const,
        transactionAmount: '20.00' as DecimalString, accountNativeAmount: '20.00' as DecimalString,
        accountNativeCurrency: 'USD' as CurrencyCode, tagIds: [] as TagId[] },
    ],
  };
}

async function seedDraftPrerequisites(pool: Pool) {
  await pool.query(`
    INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
    VALUES ('hh_01JNZQ4A9B8C7D6E5F4G3H2J1K', 'USD', 'UTC');
    INSERT INTO accounting.books (book_id, household_id, name)
    SELECT 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K', id, 'Household Book'
    FROM operations.households WHERE household_id = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
    INSERT INTO accounting.accounts
      (account_id, household_id, book_id, name, accounting_class, normal_balance, native_currency)
    SELECT values.account_id, household.id, book.id, values.name, values.class, values.normal, 'USD'
    FROM operations.households household
    JOIN accounting.books book ON book.household_id = household.id
    CROSS JOIN (VALUES
      ('account_01JNZQ4A9B8C7D6E5F4G3H2J1K', 'Food', 'expense', 'debit'),
      ('account_01JNZQ4A9B8C7D6E5F4G3H2J2K', 'Cash', 'asset', 'debit')
    ) AS values(account_id, name, class, normal);
    INSERT INTO operations.verification_tasks
      (task_id, household_id, team, status, attempt_limit, resumable)
    SELECT 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K', id, 'accounting', 'checker_validated', 2, false
    FROM operations.households WHERE household_id = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
    INSERT INTO operations.artifacts
      (artifact_id, household_id, task_id, artifact_type, schema_name, schema_version,
       canonicalization_version, hash_algorithm, artifact_hash, canonical_payload, payload)
    SELECT values.artifact_id, household.id,
      'task_01JNZQ4A9B8C7D6E5F4G3H2J1K', values.artifact_type, values.schema_name, 1,
      'rfc8785-v1', 'sha256', values.artifact_hash, '{}', '{}'
    FROM operations.households household
    CROSS JOIN (VALUES
      ('artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K', 'maker_output', 'journal-draft-input', repeat('a',64)),
      ('artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K', 'checker_output', 'checker-verdict', repeat('b',64)),
      ('artifact_01JNZQ4A9B8C7D6E5F4G3H2J3K', 'maker_output', 'journal-draft-input', repeat('c',64)),
      ('artifact_01JNZQ4A9B8C7D6E5F4G3H2J4K', 'checker_output', 'checker-verdict', repeat('d',64))
    ) AS values(artifact_id, artifact_type, schema_name, artifact_hash)
    WHERE household.household_id = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
    INSERT INTO operations.checker_verdicts
      (household_id, task_id, checker_artifact_id, covered_artifact_id, covered_artifact_hash, verdict)
    SELECT household.id, 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      values.checker_id, values.maker_id, values.maker_hash, 'accepted'
    FROM operations.households household
    CROSS JOIN (VALUES
      ('artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K',
       'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K', repeat('a',64)),
      ('artifact_01JNZQ4A9B8C7D6E5F4G3H2J4K',
       'artifact_01JNZQ4A9B8C7D6E5F4G3H2J3K', repeat('c',64))
    ) AS values(checker_id, maker_id, maker_hash)
    WHERE household.household_id = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
  `);
}
