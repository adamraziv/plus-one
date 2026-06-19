import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;

afterEach(async () => {
  await context?.cleanup();
  context = undefined;
});

const ids = {
  household: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  book: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  account: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  secondAccount: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
  period: 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  source: 'source_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  rawRow: 'rawrow_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  snapshot: 'snapshot_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  periodEvent: 'periodevent_01JNZQ4A9B8C7D6E5F4G3H2J1K',
};

describe('0006 ingestion and reconciliation', () => {
  it('rejects exact source-document replay in one source scope', async () => {
    context = await createPostgresTestContext('ingestion_replay');
    const owner = new Pool({ connectionString: context.migratorUrl });
    const accounting = new Pool({ connectionString: context.roleUrls.accounting });
    try {
      await seedBook(owner);
      await accounting.query(
        `INSERT INTO ingestion.source_documents
         (source_document_id, household_id, source_account_id, source_system, content_hash,
          byte_size, storage_key, media_type, parser_version, source_schema_version,
          extraction_status, upload_reference)
         SELECT $1, household.id, account.id, 'bank', $4, 8,
          'sha256/aa/file-1', 'text/csv', 'csv-v1', 'bank-v1', 'received', 'msg-1'
         FROM operations.households household
         JOIN accounting.accounts account ON account.household_id = household.id
         WHERE household.household_id = $2 AND account.account_id = $3`,
        [ids.source, ids.household, ids.account, 'a'.repeat(64)],
      );
      await expect(accounting.query(
        `INSERT INTO ingestion.source_documents
         (source_document_id, household_id, source_account_id, source_system, content_hash,
          byte_size, storage_key, media_type, parser_version, source_schema_version,
          extraction_status, upload_reference)
         SELECT 'source_01JNZQ4A9B8C7D6E5F4G3H2J2K', household.id, account.id,
          'bank', $3, 8, 'sha256/aa/file-2', 'text/csv', 'csv-v1', 'bank-v1',
          'received', 'msg-2'
         FROM operations.households household
         JOIN accounting.accounts account ON account.household_id = household.id
         WHERE household.household_id = $1 AND account.account_id = $2`,
        [ids.household, ids.account, 'a'.repeat(64)],
      )).rejects.toMatchObject({ code: '23505' });
    } finally {
      await accounting.end();
      await owner.end();
    }
  });

  it('keeps fallback exact fingerprints unique per source scope', async () => {
    context = await createPostgresTestContext('ingestion_fingerprint_scope');
    const owner = new Pool({ connectionString: context.migratorUrl });
    const accounting = new Pool({ connectionString: context.roleUrls.accounting });
    try {
      await seedBook(owner, true);
      await insertSourceBatchRaw(accounting, {
        sourceDocumentId: ids.source,
        sourceAccountId: ids.account,
        importBatchId: 'import_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        rawRowId: ids.rawRow,
        storageKey: 'sha256/aa/file-1',
      });
      await insertSourceBatchRaw(accounting, {
        sourceDocumentId: 'source_01JNZQ4A9B8C7D6E5F4G3H2J2K',
        sourceAccountId: ids.secondAccount,
        importBatchId: 'import_01JNZQ4A9B8C7D6E5F4G3H2J2K',
        rawRowId: 'rawrow_01JNZQ4A9B8C7D6E5F4G3H2J2K',
        storageKey: 'sha256/aa/file-2',
      });

      await insertNormalizedFallback(accounting, ids.rawRow, ids.account);
      await expect(insertNormalizedFallback(
        accounting,
        'rawrow_01JNZQ4A9B8C7D6E5F4G3H2J2K',
        ids.secondAccount,
        'normrow_01JNZQ4A9B8C7D6E5F4G3H2J2K',
      )).resolves.toBeUndefined();

      await expect(insertNormalizedFallback(
        accounting,
        ids.rawRow,
        ids.account,
        'normrow_01JNZQ4A9B8C7D6E5F4G3H2J3K',
        2,
      )).rejects.toMatchObject({ code: '23505' });
    } finally {
      await accounting.end();
      await owner.end();
    }
  });

  it('rejects updates and deletes to source bytes, raw rows, snapshots, and period events', async () => {
    context = await createPostgresTestContext('ingestion_immutable');
    const owner = new Pool({ connectionString: context.migratorUrl });
    try {
      await seedIngestionFacts(owner);
      await expect(owner.query(
        `UPDATE ingestion.source_documents SET content_hash = $1 WHERE source_document_id = $2`,
        ['b'.repeat(64), ids.source],
      )).rejects.toMatchObject({ code: '55000' });
      await expect(owner.query(
        'DELETE FROM ingestion.raw_rows WHERE raw_row_id = $1',
        [ids.rawRow],
      )).rejects.toMatchObject({ code: '55000' });
      await expect(owner.query(
        'UPDATE ingestion.statement_snapshots SET closing_balance = 0 WHERE statement_snapshot_id = $1',
        [ids.snapshot],
      )).rejects.toMatchObject({ code: '55000' });
      await expect(owner.query(
        'DELETE FROM accounting.period_events WHERE period_event_id = $1',
        [ids.periodEvent],
      )).rejects.toMatchObject({ code: '55000' });
    } finally {
      await owner.end();
    }
  });

  it('keeps statement balances independent and grants only scoped accounting access', async () => {
    context = await createPostgresTestContext('ingestion_privileges');
    const owner = new Pool({ connectionString: context.migratorUrl });
    try {
      const privileges = await owner.query<{
        accounting_batch: boolean;
        query_raw: boolean;
        planning_recon: boolean;
        accounting_delete_event: boolean;
      }>(`SELECT
        has_table_privilege('plus_one_accounting','ingestion.import_batches','SELECT,INSERT,UPDATE') AS accounting_batch,
        has_table_privilege('plus_one_query','ingestion.raw_rows','SELECT') AS query_raw,
        has_table_privilege('plus_one_planning','accounting.reconciliations','SELECT') AS planning_recon,
        has_table_privilege('plus_one_accounting','accounting.period_events','DELETE') AS accounting_delete_event`);
      expect(privileges.rows[0]).toEqual({
        accounting_batch: true,
        query_raw: false,
        planning_recon: false,
        accounting_delete_event: false,
      });
      const accountColumns = await owner.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'accounting' AND table_name = 'accounts'`,
      );
      expect(accountColumns.rows.map((row) => row.column_name)).not.toContain('statement_balance');
    } finally {
      await owner.end();
    }
  });
});

async function seedBook(pool: Pool, includeSecondAccount = false): Promise<void> {
  await pool.query(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1, 'USD', 'UTC')`,
    [ids.household],
  );
  await pool.query(
    `WITH book AS (
       INSERT INTO accounting.books (book_id, household_id, name)
       SELECT $2, id, 'Household Book' FROM operations.households WHERE household_id = $1
       RETURNING household_id, id
     ), account AS (
       INSERT INTO accounting.accounts
       (account_id, household_id, book_id, name, accounting_class, normal_balance, native_currency)
       SELECT $3, household_id, id, 'Checking', 'asset', 'debit', 'USD' FROM book
     ), second_account AS (
       INSERT INTO accounting.accounts
       (account_id, household_id, book_id, name, accounting_class, normal_balance, native_currency)
       SELECT $5, household_id, id, 'Savings', 'asset', 'debit', 'USD' FROM book WHERE $6
     )
     INSERT INTO accounting.periods (period_id, household_id, book_id, period_start, period_end)
     SELECT $4, household_id, id, DATE '2026-05-01', DATE '2026-05-31' FROM book`,
    [ids.household, ids.book, ids.account, ids.period, ids.secondAccount, includeSecondAccount],
  );
}

async function insertSourceBatchRaw(pool: Pool, input: {
  sourceDocumentId: string;
  sourceAccountId: string;
  importBatchId: string;
  rawRowId: string;
  storageKey: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO ingestion.source_documents
     (source_document_id, household_id, source_account_id, source_system, content_hash,
      byte_size, storage_key, media_type, parser_version, source_schema_version,
      extraction_status, upload_reference)
     SELECT $1, household.id, account.id, 'bank', $4, 8, $5,
      'text/csv', 'csv-v1', 'bank-v1', 'received', $6
     FROM operations.households household
     JOIN accounting.accounts account ON account.household_id = household.id
     WHERE household.household_id = $2 AND account.account_id = $3`,
    [input.sourceDocumentId, ids.household, input.sourceAccountId, 'a'.repeat(64),
      input.storageKey, input.sourceDocumentId],
  );
  await pool.query(
    `INSERT INTO ingestion.import_batches (import_batch_id, household_id, source_document_id, state)
     SELECT $1, household.id, source.id, 'received'
     FROM operations.households household
     JOIN ingestion.source_documents source ON source.household_id = household.id
     WHERE household.household_id = $2 AND source.source_document_id = $3`,
    [input.importBatchId, ids.household, input.sourceDocumentId],
  );
  await pool.query(
    `INSERT INTO ingestion.raw_rows
     (raw_row_id, import_batch_id, source_row_identity, source_row_number, raw_payload, canonical_raw_hash)
     SELECT $1, id, 'row-1', 1, '{"amount":"12.00"}'::jsonb, $2
     FROM ingestion.import_batches WHERE import_batch_id = $3`,
    [input.rawRowId, 'd'.repeat(64), input.importBatchId],
  );
}

async function insertNormalizedFallback(
  pool: Pool,
  rawRowId: string,
  accountId: string,
  normalizedRowId = 'normrow_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  version = 1,
): Promise<void> {
  await pool.query(
    `INSERT INTO ingestion.normalized_rows
     (normalized_row_id, raw_row_id, version, occurred_on, amount, currency,
      description, parser_version, normalized_payload, exact_fingerprint, fingerprint_kind, row_state)
     SELECT $1, raw.id, $2, DATE '2026-05-01', 12.00, 'USD',
      $3, 'csv-v1', '{"amount":"12.00"}'::jsonb, $4, 'source_row_fallback', 'ready'
     FROM ingestion.raw_rows raw WHERE raw.raw_row_id = $5`,
    [normalizedRowId, version, `Fallback ${accountId}`, 'f'.repeat(64), rawRowId],
  );
}

async function seedIngestionFacts(pool: Pool): Promise<void> {
  await seedBook(pool);
  await pool.query(
    `INSERT INTO operations.verification_tasks
     (task_id, household_id, team, status, attempt_limit, resumable, terminal_at)
     SELECT 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K', id, 'accounting', 'verified', 2, false, clock_timestamp()
     FROM operations.households WHERE household_id = $1`,
    [ids.household],
  );
  await pool.query(
    `INSERT INTO operations.artifacts
     (artifact_id, household_id, task_id, artifact_type, schema_name, schema_version,
      canonicalization_version, hash_algorithm, artifact_hash, canonical_payload, payload)
     SELECT 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K', id,
      'task_01JNZQ4A9B8C7D6E5F4G3H2J1K', 'maker_output', 'test-artifact', 1,
      'rfc8785-v1', 'sha256', $2, '{}', '{"schemaName":"test-artifact"}'::jsonb
     FROM operations.households WHERE household_id = $1`,
    [ids.household, 'c'.repeat(64)],
  );
  await pool.query(
    `INSERT INTO ingestion.source_documents
     (source_document_id, household_id, source_account_id, source_system, content_hash,
      byte_size, storage_key, media_type, parser_version, source_schema_version,
      extraction_status, upload_reference)
     SELECT $1, household.id, account.id, 'bank', $4, 8, 'sha256/aa/file-1',
      'text/csv', 'csv-v1', 'bank-v1', 'received', 'msg-1'
     FROM operations.households household
     JOIN accounting.accounts account ON account.household_id = household.id
     WHERE household.household_id = $2 AND account.account_id = $3`,
    [ids.source, ids.household, ids.account, 'a'.repeat(64)],
  );
  await pool.query(
    `INSERT INTO ingestion.import_batches (import_batch_id, household_id, source_document_id, state)
     SELECT 'import_01JNZQ4A9B8C7D6E5F4G3H2J1K', household.id, source.id, 'received'
     FROM operations.households household
     JOIN ingestion.source_documents source ON source.household_id = household.id
     WHERE household.household_id = $1 AND source.source_document_id = $2`,
    [ids.household, ids.source],
  );
  await pool.query(
    `INSERT INTO ingestion.raw_rows
     (raw_row_id, import_batch_id, source_row_identity, source_row_number, raw_payload, canonical_raw_hash)
     SELECT $1, id, '1', 1, '{"amount":"12.00"}'::jsonb, $2
     FROM ingestion.import_batches
     WHERE import_batch_id = 'import_01JNZQ4A9B8C7D6E5F4G3H2J1K'`,
    [ids.rawRow, 'd'.repeat(64)],
  );
  await pool.query(
    `INSERT INTO ingestion.statement_snapshots
     (statement_snapshot_id, household_id, source_document_id, account_id, period_start, period_end,
      currency, opening_balance, closing_balance)
     SELECT $1, household.id, source.id, account.id,
      DATE '2026-05-01', DATE '2026-05-31', 'USD', 100, 88
     FROM operations.households household
     JOIN ingestion.source_documents source ON source.household_id = household.id
     JOIN accounting.accounts account ON account.household_id = household.id
     WHERE household.household_id = $2 AND source.source_document_id = $3
       AND account.account_id = $4`,
    [ids.snapshot, ids.household, ids.source, ids.account],
  );
  await pool.query(
    `INSERT INTO accounting.period_events
     (period_event_id, household_id, book_id, period_id, event_type, reconciliation_ids,
      unresolved_discrepancy_ids, responsible_artifact_ids, checked_artifact_id)
     SELECT $1, household.id, book.id, period.id, 'closed', '[]'::jsonb, '[]'::jsonb,
      '["artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K"]'::jsonb, artifact.id
     FROM operations.households household
     JOIN accounting.books book ON book.household_id = household.id
     JOIN accounting.periods period ON period.household_id = household.id AND period.book_id = book.id
     JOIN operations.artifacts artifact ON artifact.household_id = household.id
     WHERE household.household_id = $2 AND book.book_id = $3 AND period.period_id = $4
       AND artifact.artifact_id = 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K'`,
    [ids.periodEvent, ids.household, ids.book, ids.period],
  );
}
