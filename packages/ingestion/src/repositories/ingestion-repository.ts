import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { PlusOneError } from '@plus-one/contracts';
import type { ExtractedRawRow } from '../source/source-extractor.js';
import type { StoredSourceObject } from '../source/source-object-store.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;

export interface ImportBatchRecord {
  importBatchId: string;
  state: string;
  batchVersion?: number;
}

export interface SourceDocumentRecord {
  sourceDocumentId: string;
  contentHash: string;
}

export interface LatestImportRow {
  normalizedRowId: string;
  rowState: string;
  normalizedPayload: unknown;
}

export class IngestionRepository {
  constructor(private readonly client: PoolClient) {}

  async findBySourceScopeAndHash(input: {
    householdId: string;
    sourceAccountId: string;
    sourceSystem: string;
    contentHash: string;
  }): Promise<ImportBatchRecord | undefined> {
    const result = await this.client.query<ImportBatchRecord>(
      `SELECT batch.import_batch_id AS "importBatchId", batch.state
       FROM ingestion.source_documents document
       JOIN operations.households household ON household.id = document.household_id
       JOIN accounting.accounts account ON account.id = document.source_account_id
       JOIN ingestion.import_batches batch ON batch.source_document_id = document.id
       WHERE household.household_id = $1 AND account.account_id = $2
         AND document.source_system = $3 AND document.content_hash = $4
       ORDER BY batch.batch_version DESC LIMIT 1`,
      [input.householdId, input.sourceAccountId, input.sourceSystem, input.contentHash],
    );
    return result.rows[0];
  }

  async insertSourceDocument(input: {
    householdId: string;
    sourceAccountId: string;
    sourceSystem: string;
    uploadReference: string;
    parserVersion: string;
    sourceSchemaVersion: string;
  } & StoredSourceObject): Promise<SourceDocumentRecord> {
    const result = await this.client.query<SourceDocumentRecord>(
      `INSERT INTO ingestion.source_documents
       (source_document_id, household_id, source_account_id, source_system, content_hash,
        byte_size, storage_key, media_type, parser_version, source_schema_version,
        extraction_status, upload_reference)
       SELECT $1, household.id, account.id, $4, $5, $6, $7, $8, $9, $10, 'received', $11
       FROM operations.households household
       JOIN accounting.accounts account ON account.household_id = household.id
       WHERE household.household_id = $2 AND account.account_id = $3
       RETURNING source_document_id AS "sourceDocumentId", content_hash AS "contentHash"`,
      [
        id('source'),
        input.householdId,
        input.sourceAccountId,
        input.sourceSystem,
        input.contentHash,
        input.byteSize,
        input.storageKey,
        input.mediaType,
        input.parserVersion,
        input.sourceSchemaVersion,
        input.uploadReference,
      ],
    );
    return this.one(result.rows[0], 'source_document_insert_failed');
  }

  async insertBatch(sourceDocumentId: string): Promise<ImportBatchRecord> {
    const result = await this.client.query<ImportBatchRecord>(
      `INSERT INTO ingestion.import_batches (import_batch_id, household_id, source_document_id, state)
       SELECT $1, household_id, id, 'received'
       FROM ingestion.source_documents WHERE source_document_id = $2
       RETURNING import_batch_id AS "importBatchId", state, batch_version AS "batchVersion"`,
      [id('import'), sourceDocumentId],
    );
    return this.one(result.rows[0], 'import_batch_insert_failed');
  }

  async insertRawRows(importBatchId: string, rows: ExtractedRawRow[]): Promise<void> {
    for (const row of rows) {
      const result = await this.client.query(
        `INSERT INTO ingestion.raw_rows
         (raw_row_id, import_batch_id, source_row_identity, source_row_number, raw_payload, canonical_raw_hash)
         SELECT $1, batch.id, $3, $4, $5, $6
         FROM ingestion.import_batches batch WHERE batch.import_batch_id = $2`,
        [
          id('rawrow'),
          importBatchId,
          row.sourceRowIdentity,
          row.sourceRowNumber,
          row.rawPayload,
          hash(row.rawPayload),
        ],
      );
      if (result.rowCount !== 1) this.fail('raw_row_insert_failed');
    }
  }

  async insertNormalizedVersion(input: {
    rawRowId: string;
    normalizedRowId: string;
    version: number;
    occurredOn: string;
    postedOn?: string;
    amount: string;
    currency: string;
    description: string;
    counterparty?: string;
    externalTransactionId?: string;
    parserVersion: string;
    normalizedPayload: unknown;
    warnings: unknown[];
    exactFingerprint: string;
    fingerprintKind: string;
    rowState: string;
  }): Promise<void> {
    const result = await this.client.query(
      `INSERT INTO ingestion.normalized_rows
       (normalized_row_id, raw_row_id, version, occurred_on, posted_on, amount, currency,
        description, counterparty, external_transaction_id, parser_version, normalized_payload,
        warnings, exact_fingerprint, fingerprint_kind, row_state)
       SELECT $1, raw.id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
       FROM ingestion.raw_rows raw WHERE raw.raw_row_id = $2`,
      [
        input.normalizedRowId, input.rawRowId, input.version, input.occurredOn, input.postedOn ?? null,
        input.amount, input.currency, input.description, input.counterparty ?? null,
        input.externalTransactionId ?? null, input.parserVersion, input.normalizedPayload,
        JSON.stringify(input.warnings), input.exactFingerprint, input.fingerprintKind, input.rowState,
      ],
    );
    if (result.rowCount !== 1) this.fail('normalized_row_insert_failed');
  }

  async insertMatchDecision(input: {
    matchDecisionId: string;
    normalizedRowId: string;
    candidateJournalId?: string;
    decision: string;
    score: number;
    evidence: unknown;
    makerArtifactId?: string;
    checkerArtifactId?: string;
  }): Promise<void> {
    const result = await this.client.query(
      `INSERT INTO ingestion.match_decisions
       (match_decision_id, normalized_row_id, candidate_journal_id, decision, score, evidence,
        maker_artifact_id, checker_artifact_id)
       SELECT $1, row.id, journal.id, $4, $5, $6, maker.id, checker.id
       FROM ingestion.normalized_rows row
       LEFT JOIN accounting.journals journal ON journal.journal_id = $3
       LEFT JOIN operations.artifacts maker ON maker.artifact_id = $7
       LEFT JOIN operations.artifacts checker ON checker.artifact_id = $8
       WHERE row.normalized_row_id = $2`,
      [
        input.matchDecisionId, input.normalizedRowId, input.candidateJournalId ?? null,
        input.decision, input.score, input.evidence, input.makerArtifactId ?? null,
        input.checkerArtifactId ?? null,
      ],
    );
    if (result.rowCount !== 1) this.fail('match_decision_insert_failed');
  }

  async lockBatch(importBatchId: string): Promise<ImportBatchRecord | undefined> {
    const result = await this.client.query<ImportBatchRecord>(
      `SELECT import_batch_id AS "importBatchId", state, batch_version AS "batchVersion"
       FROM ingestion.import_batches WHERE import_batch_id = $1 FOR UPDATE`,
      [importBatchId],
    );
    return result.rows[0];
  }

  async transitionBatch(
    importBatchId: string,
    from: string,
    to: string,
    artifact?: { id: string; hash: string },
  ): Promise<void> {
    const result = await this.client.query(
      `UPDATE ingestion.import_batches
       SET state = $3,
         checked_artifact_id = COALESCE((SELECT id FROM operations.artifacts WHERE artifact_id = $4), checked_artifact_id),
         checked_artifact_hash = COALESCE($5, checked_artifact_hash)
       WHERE import_batch_id = $1 AND state = $2
       RETURNING import_batch_id`,
      [importBatchId, from, to, artifact?.id ?? null, artifact?.hash ?? null],
    );
    if (result.rowCount !== 1) this.fail('import_batch_transition_failed');
  }

  async listLatestRows(importBatchId: string): Promise<LatestImportRow[]> {
    const result = await this.client.query<LatestImportRow>(
      `SELECT DISTINCT ON (raw.raw_row_id)
        normalized.normalized_row_id AS "normalizedRowId",
        normalized.row_state AS "rowState",
        normalized.normalized_payload AS "normalizedPayload"
       FROM ingestion.raw_rows raw
       JOIN ingestion.import_batches batch ON batch.id = raw.import_batch_id
       JOIN ingestion.normalized_rows normalized ON normalized.raw_row_id = raw.id
       WHERE batch.import_batch_id = $1
       ORDER BY raw.raw_row_id, normalized.version DESC`,
      [importBatchId],
    );
    return result.rows;
  }

  async insertRowDecision(input: {
    importBatchId: string;
    normalizedRowId: string;
    checkedArtifactId: string;
    checkedArtifactHash: string;
    action: string;
    targetJournalId?: string;
    reasonCode: string;
  }): Promise<void> {
    const result = await this.client.query(
      `INSERT INTO ingestion.import_row_decisions
       (import_batch_id, normalized_row_id, checked_artifact_id, checked_artifact_hash,
        action, target_journal_id, reason_code)
       SELECT batch.id, row.id, artifact.id, $4, $5, journal.id, $7
       FROM ingestion.import_batches batch
       JOIN ingestion.normalized_rows row ON row.normalized_row_id = $2
       JOIN operations.artifacts artifact ON artifact.artifact_id = $3
       LEFT JOIN accounting.journals journal ON journal.journal_id = $6
       WHERE batch.import_batch_id = $1`,
      [
        input.importBatchId, input.normalizedRowId, input.checkedArtifactId,
        input.checkedArtifactHash, input.action, input.targetJournalId ?? null, input.reasonCode,
      ],
    );
    if (result.rowCount !== 1) this.fail('row_decision_insert_failed');
  }

  async insertStatementSnapshot(input: {
    statementSnapshotId: string;
    householdId: string;
    sourceDocumentId: string;
    accountId: string;
    periodStart: string;
    periodEnd: string;
    currency: string;
    openingBalance: string;
    closingBalance: string;
  }): Promise<void> {
    const result = await this.client.query(
      `INSERT INTO ingestion.statement_snapshots
       (statement_snapshot_id, household_id, source_document_id, account_id, period_start,
        period_end, currency, opening_balance, closing_balance)
       SELECT $1, household.id, source.id, account.id, $5, $6, $7, $8, $9
       FROM operations.households household
       JOIN ingestion.source_documents source ON source.household_id = household.id
       JOIN accounting.accounts account ON account.household_id = household.id
       WHERE household.household_id = $2 AND source.source_document_id = $3 AND account.account_id = $4`,
      [
        input.statementSnapshotId, input.householdId, input.sourceDocumentId, input.accountId,
        input.periodStart, input.periodEnd, input.currency, input.openingBalance, input.closingBalance,
      ],
    );
    if (result.rowCount !== 1) this.fail('statement_snapshot_insert_failed');
  }

  async linkJournalSource(input: {
    journalId: string;
    normalizedRowId: string;
    linkKind: string;
    checkedArtifactId: string;
  }): Promise<void> {
    const result = await this.client.query(
      `INSERT INTO accounting.journal_source_links
       (journal_id, normalized_row_id, link_kind, checked_artifact_id)
       SELECT journal.id, row.id, $3, artifact.id
       FROM accounting.journals journal
       JOIN ingestion.normalized_rows row ON row.normalized_row_id = $2
       JOIN operations.artifacts artifact ON artifact.artifact_id = $4
       WHERE journal.journal_id = $1`,
      [input.journalId, input.normalizedRowId, input.linkKind, input.checkedArtifactId],
    );
    if (result.rowCount !== 1) this.fail('journal_source_link_failed');
  }

  async readBatchOutcome(importBatchId: string): Promise<unknown> {
    const result = await this.client.query(
      `SELECT batch.state,
        count(*) FILTER (WHERE decision.action = 'post')::integer AS posted,
        count(*) FILTER (WHERE decision.action = 'link_existing')::integer AS "linkedExisting",
        count(*) FILTER (WHERE decision.action = 'defer')::integer AS deferred,
        count(*) FILTER (WHERE decision.action = 'reject')::integer AS rejected
       FROM ingestion.import_batches batch
       LEFT JOIN ingestion.import_row_decisions decision ON decision.import_batch_id = batch.id
       WHERE batch.import_batch_id = $1
       GROUP BY batch.state`,
      [importBatchId],
    );
    return this.one(result.rows[0], 'batch_outcome_not_found');
  }

  async readSourceLineage(normalizedRowId: string): Promise<unknown> {
    const result = await this.client.query(
      `SELECT row.normalized_row_id AS "normalizedRowId", raw.raw_row_id AS "rawRowId",
        batch.import_batch_id AS "importBatchId", source.source_document_id AS "sourceDocumentId"
       FROM ingestion.normalized_rows row
       JOIN ingestion.raw_rows raw ON raw.id = row.raw_row_id
       JOIN ingestion.import_batches batch ON batch.id = raw.import_batch_id
       JOIN ingestion.source_documents source ON source.id = batch.source_document_id
       WHERE row.normalized_row_id = $1`,
      [normalizedRowId],
    );
    return this.one(result.rows[0], 'source_lineage_not_found');
  }

  private one<T>(row: T | undefined, code: string): T {
    if (row === undefined) this.fail(code);
    return row;
  }

  private fail(code: string): never {
    throw new PlusOneError({
      category: 'constraint_violation',
      code,
      message: 'Ingestion repository operation failed',
      retry: 'after_state_resolution',
      receiptLookupRequired: false,
      details: {},
    });
  }
}
