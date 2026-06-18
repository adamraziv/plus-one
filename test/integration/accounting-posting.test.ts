import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import {
  AccountingRepository, JournalDraftRepository, JournalPostingService, LedgerReadback,
} from '@plus-one/accounting';
import type {
  AccountId, BookId, CurrencyCode, DecimalString, HouseholdId, JournalDraftId,
  JournalId, LocalDate, PeriodId, TaskId, ArtifactId,
} from '@plus-one/contracts';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;
afterEach(async () => { await context?.cleanup(); context = undefined; });

describe('journal posting', () => {
  it('posts a checked split journal and forces deferred constraints before returning', async () => {
    context = await createPostgresTestContext('accounting_posting');
    const owner = new Pool({ connectionString: context.migratorUrl });
    const pool = new Pool({ connectionString: context.roleUrls.accounting });
    await seedOperationalApproval(owner);
    const client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await seedAccountingFoundation(client);
    const applyJournal = vi.fn().mockResolvedValue(undefined);
    const service = new JournalPostingService({ applyJournal });
    const input = postInput();
    const result = await service.postInTransaction(client, input);
    expect(result.journalId).toBe('journal_01JNZQ4A9B8C7D6E5F4G3H2J1K');
    expect(result.postingIds.length).toBe(3);
    expect(applyJournal).toHaveBeenCalledWith(client, expect.objectContaining({
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      effectiveOn: '2026-06-14',
      postingIds: expect.any(Array),
    }));
    const readback = new LedgerReadback();
    await expect(readback.verifyPostedJournal(client, {
      householdId: input.householdId, expected: input,
    })).resolves.toMatchObject({ ok: true, journalId: result.journalId, mismatches: [] });
    await client.query('COMMIT');
    const totals = await owner.query(
      `SELECT direction, sum(transaction_amount)::text AS amount
       FROM accounting.postings GROUP BY direction ORDER BY direction`,
    );
    expect(totals.rows).toEqual([
      { direction: 'credit', amount: '20.000000000000' },
      { direction: 'debit', amount: '20.000000000000' },
    ]);
    client.release();
    await pool.end();
    await owner.end();
  });

  it('rejects unbalanced input at the database boundary before the service returns', async () => {
    context = await createPostgresTestContext('accounting_posting_unbalanced');
    const owner = new Pool({ connectionString: context.migratorUrl });
    const pool = new Pool({ connectionString: context.roleUrls.accounting });
    await seedOperationalApproval(owner);
    const client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await seedAccountingFoundation(client);
    const invalid = postInput();
    invalid.postings[2]!.transactionAmount = '11.00' as DecimalString;
    invalid.postings[2]!.accountNativeAmount = '11.00' as DecimalString;
    await expect(new JournalPostingService().postInTransaction(client, invalid))
      .rejects.toMatchObject({ category: 'constraint_violation' });
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
    await owner.end();
  });
});

function postInput() {
  return {
    schemaName: 'post-journal-input' as const, schemaVersion: 1 as const,
    householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K' as HouseholdId,
    bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' as BookId,
    journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K' as JournalId,
    draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J1K' as JournalDraftId,
    periodId: 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K' as PeriodId,
    taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K' as TaskId,
    checkedArtifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K' as ArtifactId,
    checkedArtifactHash: 'a'.repeat(64), journalType: 'ordinary' as const,
    transactionCurrency: 'USD' as CurrencyCode, occurredOn: '2026-06-14' as LocalDate,
    effectiveOn: '2026-06-14' as LocalDate,
    description: 'Split grocery purchase', tagIds: [],
    postings: [
      { accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K' as AccountId, direction: 'debit' as const,
        transactionAmount: '8.00' as DecimalString, accountNativeAmount: '8.00' as DecimalString,
        accountNativeCurrency: 'USD' as CurrencyCode, tagIds: [] },
      { accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K' as AccountId, direction: 'debit' as const,
        transactionAmount: '12.00' as DecimalString, accountNativeAmount: '12.00' as DecimalString,
        accountNativeCurrency: 'USD' as CurrencyCode, tagIds: [] },
      { accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J3K' as AccountId, direction: 'credit' as const,
        transactionAmount: '20.00' as DecimalString, accountNativeAmount: '20.00' as DecimalString,
        accountNativeCurrency: 'USD' as CurrencyCode, tagIds: [] },
    ],
  };
}

async function seedOperationalApproval(pool: Pool) {
  await pool.query(`
    INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
    VALUES ('hh_01JNZQ4A9B8C7D6E5F4G3H2J1K', 'USD', 'UTC');
    INSERT INTO operations.verification_tasks
      (task_id, household_id, team, status, attempt_limit, resumable)
    SELECT 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K', id, 'accounting', 'checker_validated', 2, false
    FROM operations.households WHERE household_id = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
    INSERT INTO operations.artifacts
      (artifact_id, household_id, task_id, artifact_type, schema_name, schema_version,
       canonicalization_version, hash_algorithm, artifact_hash, canonical_payload, payload)
    SELECT values.artifact_id, household.id, 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      values.artifact_type, values.schema_name, 1, 'rfc8785-v1', 'sha256',
      values.artifact_hash, '{}', '{}'
    FROM operations.households household
    CROSS JOIN (VALUES
      ('artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K','maker_output','journal-draft-input',repeat('a',64)),
      ('artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K','checker_output','checker-verdict',repeat('b',64))
    ) AS values(artifact_id, artifact_type, schema_name, artifact_hash)
    WHERE household.household_id = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
    INSERT INTO operations.checker_verdicts
      (household_id, task_id, checker_artifact_id, covered_artifact_id, covered_artifact_hash, verdict)
    SELECT id, 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      'artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K',
      'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K', repeat('a',64), 'accepted'
    FROM operations.households WHERE household_id = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
  `);
}

async function seedAccountingFoundation(client: import('pg').PoolClient) {
  const accounting = new AccountingRepository();
  await accounting.createBookWithConfiguration(client, {
    householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    configurationId: 'bookconfig_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    name: 'Household Book', reportingCurrency: 'USD', effectiveFrom: '2026-01-01',
  });
  for (const account of [
    ['account_01JNZQ4A9B8C7D6E5F4G3H2J1K','Groceries','expense'],
    ['account_01JNZQ4A9B8C7D6E5F4G3H2J2K','Household','expense'],
    ['account_01JNZQ4A9B8C7D6E5F4G3H2J3K','Cash','asset'],
  ] as const) {
    await accounting.createAccount(client, {
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      accountId: account[0], name: account[1], accountingClass: account[2],
      normalBalance: 'debit', nativeCurrency: 'USD',
    });
  }
  await accounting.createPeriod(client, {
    householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    periodId: 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    periodStart: '2026-06-01', periodEnd: '2026-06-30',
  });
  await new JournalDraftRepository().insertVersion(client, {
    schemaName: 'journal-draft-input', schemaVersion: 1,
    householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K' as HouseholdId,
    bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' as BookId,
    draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J1K' as JournalDraftId,
    draftSeriesId: 'draftseries_01JNZQ4A9B8C7D6E5F4G3H2J1K' as import('@plus-one/contracts').DraftSeriesId,
    version: 1,
    taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K' as TaskId,
    checkedArtifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K' as ArtifactId,
    checkedArtifactHash: 'a'.repeat(64), journalType: 'ordinary' as const,
    transactionCurrency: 'USD' as CurrencyCode,
    occurredOn: '2026-06-14' as LocalDate, effectiveOn: '2026-06-14' as LocalDate,
    description: 'Split grocery purchase', tagIds: [],
    postings: postInput().postings.map((p) => ({
      accountId: p.accountId, direction: p.direction,
      transactionAmount: p.transactionAmount, accountNativeAmount: p.accountNativeAmount,
      accountNativeCurrency: p.accountNativeCurrency, tagIds: p.tagIds,
    })),
  });
}
