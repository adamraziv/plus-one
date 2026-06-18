import type { PoolClient } from 'pg';
import { PlusOneError } from '@plus-one/contracts';

export class ReconciliationRepository {
  constructor(private readonly client: PoolClient) {}

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

  async insertReconciliation(input: {
    reconciliationId: string;
    householdId: string;
    bookId: string;
    accountId: string;
    statementSnapshotId: string;
    periodStart: string;
    periodEnd: string;
    currency: string;
    ledgerOpeningBalance: string;
    ledgerClosingBalance: string;
    statementOpeningBalance: string;
    statementClosingBalance: string;
    completionStatus: string;
    unresolvedDiscrepancies: unknown;
    makerArtifactId: string;
    checkerArtifactId: string;
  }): Promise<void> {
    const result = await this.client.query(
      `INSERT INTO accounting.reconciliations
       (reconciliation_id, household_id, book_id, account_id, statement_snapshot_id,
        period_start, period_end, currency, ledger_opening_balance, ledger_closing_balance,
        statement_opening_balance, statement_closing_balance, completion_status,
        unresolved_discrepancies, maker_artifact_id, checker_artifact_id)
       SELECT $1, household.id, book.id, account.id, snapshot.id, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, maker.id, checker.id
       FROM operations.households household
       JOIN accounting.books book ON book.household_id = household.id
       JOIN accounting.accounts account ON account.household_id = household.id AND account.book_id = book.id
       JOIN ingestion.statement_snapshots snapshot ON snapshot.household_id = household.id AND snapshot.account_id = account.id
       JOIN operations.artifacts maker ON maker.household_id = household.id
       JOIN operations.artifacts checker ON checker.household_id = household.id
       WHERE household.household_id = $2 AND book.book_id = $3 AND account.account_id = $4
         AND snapshot.statement_snapshot_id = $5 AND maker.artifact_id = $15 AND checker.artifact_id = $16`,
      [
        input.reconciliationId, input.householdId, input.bookId, input.accountId,
        input.statementSnapshotId, input.periodStart, input.periodEnd, input.currency,
        input.ledgerOpeningBalance, input.ledgerClosingBalance, input.statementOpeningBalance,
        input.statementClosingBalance, input.completionStatus, input.unresolvedDiscrepancies,
        input.makerArtifactId, input.checkerArtifactId,
      ],
    );
    if (result.rowCount !== 1) this.fail('reconciliation_insert_failed');
  }

  async insertItems(reconciliationId: string, items: Array<{
    reconciliationItemId: string;
    statementLineId?: string;
    normalizedRowId?: string;
    journalId?: string;
    status: string;
    amountDifference: string;
    explanation?: string;
  }>): Promise<void> {
    for (const item of items) {
      const result = await this.client.query(
        `INSERT INTO accounting.reconciliation_items
         (reconciliation_item_id, reconciliation_id, statement_line_id, normalized_row_id,
          journal_id, status, amount_difference, explanation)
         SELECT $1, reconciliation.id, statement_line.id, normalized.id, journal.id, $6, $7, $8
         FROM accounting.reconciliations reconciliation
         LEFT JOIN ingestion.statement_lines statement_line ON statement_line.statement_line_id = $3
         LEFT JOIN ingestion.normalized_rows normalized ON normalized.normalized_row_id = $4
         LEFT JOIN accounting.journals journal ON journal.journal_id = $5
         WHERE reconciliation.reconciliation_id = $2`,
        [
          item.reconciliationItemId, reconciliationId, item.statementLineId ?? null,
          item.normalizedRowId ?? null, item.journalId ?? null, item.status,
          item.amountDifference, item.explanation ?? null,
        ],
      );
      if (result.rowCount !== 1) this.fail('reconciliation_item_insert_failed');
    }
  }

  async insertEvidenceLinks(reconciliationId: string, artifactIds: string[]): Promise<void> {
    for (const artifactId of artifactIds) {
      const result = await this.client.query(
        `INSERT INTO accounting.reconciliation_evidence (reconciliation_id, artifact_id)
         SELECT reconciliation.id, artifact.id
         FROM accounting.reconciliations reconciliation
         JOIN operations.artifacts artifact ON artifact.household_id = reconciliation.household_id
         WHERE reconciliation.reconciliation_id = $1 AND artifact.artifact_id = $2`,
        [reconciliationId, artifactId],
      );
      if (result.rowCount !== 1) this.fail('reconciliation_evidence_insert_failed');
    }
  }

  async insertPeriodEvent(input: {
    periodEventId: string;
    householdId: string;
    bookId: string;
    periodId: string;
    eventType: 'closed' | 'reopened';
    priorEventId?: string;
    reconciliationIds: unknown;
    unresolvedDiscrepancyIds: unknown;
    responsibleArtifactIds: unknown;
    checkedArtifactId: string;
    confirmationId?: string;
    reason?: string;
  }): Promise<void> {
    const result = await this.client.query(
      `INSERT INTO accounting.period_events
       (period_event_id, household_id, book_id, period_id, event_type, prior_event_id,
        reconciliation_ids, unresolved_discrepancy_ids, responsible_artifact_ids,
        checked_artifact_id, confirmation_id, reason)
       SELECT $1, household.id, book.id, period.id, $5, prior.id, $7, $8, $9,
        artifact.id, confirmation.id, $12
       FROM operations.households household
       JOIN accounting.books book ON book.household_id = household.id
       JOIN accounting.periods period ON period.household_id = household.id AND period.book_id = book.id
       JOIN operations.artifacts artifact ON artifact.household_id = household.id
       LEFT JOIN accounting.period_events prior ON prior.household_id = household.id AND prior.period_event_id = $6
       LEFT JOIN operations.external_confirmations confirmation ON confirmation.household_id = household.id AND confirmation.confirmation_id = $11
       WHERE household.household_id = $2 AND book.book_id = $3 AND period.period_id = $4
         AND artifact.artifact_id = $10`,
      [
        input.periodEventId, input.householdId, input.bookId, input.periodId,
        input.eventType, input.priorEventId ?? null, input.reconciliationIds,
        input.unresolvedDiscrepancyIds, input.responsibleArtifactIds, input.checkedArtifactId,
        input.confirmationId ?? null, input.reason ?? null,
      ],
    );
    if (result.rowCount !== 1) this.fail('period_event_insert_failed');
  }

  async setPeriodStatus(input: {
    householdId: string;
    bookId: string;
    periodId: string;
    state: 'open' | 'closed';
  }): Promise<void> {
    const result = await this.client.query(
      `UPDATE accounting.periods period
       SET state = $4,
         closed_at = CASE WHEN $4 = 'closed' THEN clock_timestamp() ELSE NULL END,
         reopened_at = CASE WHEN $4 = 'open' THEN clock_timestamp() ELSE reopened_at END,
         updated_at = clock_timestamp()
       FROM operations.households household, accounting.books book
       WHERE period.household_id = household.id AND period.book_id = book.id
         AND household.household_id = $1 AND book.book_id = $2 AND period.period_id = $3`,
      [input.householdId, input.bookId, input.periodId, input.state],
    );
    if (result.rowCount !== 1) this.fail('period_status_update_failed');
  }

  async readReconciliation(reconciliationId: string): Promise<unknown> {
    const result = await this.client.query(
      `SELECT reconciliation.reconciliation_id AS "reconciliationId",
        household.household_id AS "householdId", book.book_id AS "bookId",
        account.account_id AS "accountId", snapshot.statement_snapshot_id AS "statementSnapshotId",
        reconciliation.period_start::text AS "periodStart",
        reconciliation.period_end::text AS "periodEnd", reconciliation.currency,
        reconciliation.ledger_opening_balance::text AS "ledgerOpeningBalance",
        reconciliation.ledger_closing_balance::text AS "ledgerClosingBalance",
        reconciliation.statement_opening_balance::text AS "statementOpeningBalance",
        reconciliation.statement_closing_balance::text AS "statementClosingBalance",
        COALESCE(evidence."artifactIds", '[]'::jsonb) AS "evidenceArtifactIds",
        COALESCE(items.items, '[]'::jsonb) AS items,
        reconciliation.unresolved_discrepancies AS "unresolvedDiscrepancies",
        reconciliation.completion_status AS "completionStatus"
       FROM accounting.reconciliations reconciliation
       JOIN operations.households household ON household.id = reconciliation.household_id
       JOIN accounting.books book ON book.id = reconciliation.book_id
       JOIN accounting.accounts account ON account.id = reconciliation.account_id
       JOIN ingestion.statement_snapshots snapshot ON snapshot.id = reconciliation.statement_snapshot_id
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(artifact.artifact_id ORDER BY artifact.artifact_id) AS "artifactIds"
         FROM accounting.reconciliation_evidence link
         JOIN operations.artifacts artifact ON artifact.id = link.artifact_id
         WHERE link.reconciliation_id = reconciliation.id
       ) evidence ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'reconciliationItemId', item.reconciliation_item_id,
           'statementLineId', statement_line.statement_line_id,
           'normalizedRowId', normalized.normalized_row_id,
           'journalId', journal.journal_id,
           'status', item.status,
           'amountDifference', item.amount_difference::text,
           'explanation', item.explanation
         )) ORDER BY item.reconciliation_item_id) AS items
         FROM accounting.reconciliation_items item
         LEFT JOIN ingestion.statement_lines statement_line ON statement_line.id = item.statement_line_id
         LEFT JOIN ingestion.normalized_rows normalized ON normalized.id = item.normalized_row_id
         LEFT JOIN accounting.journals journal ON journal.id = item.journal_id
         WHERE item.reconciliation_id = reconciliation.id
       ) items ON true
       WHERE reconciliation.reconciliation_id = $1`,
      [reconciliationId],
    );
    return this.one(result.rows[0], 'reconciliation_not_found');
  }

  async readLatestPeriodEvent(householdId: string, bookId: string, periodId: string): Promise<unknown> {
    const result = await this.client.query(
      `SELECT event.period_event_id AS "periodEventId", event.event_type AS "eventType"
       FROM accounting.period_events event
       JOIN operations.households household ON household.id = event.household_id
       JOIN accounting.books book ON book.id = event.book_id
       JOIN accounting.periods period ON period.id = event.period_id
       WHERE household.household_id = $1 AND book.book_id = $2 AND period.period_id = $3
       ORDER BY event.created_at DESC LIMIT 1`,
      [householdId, bookId, periodId],
    );
    return result.rows[0];
  }

  async readPeriodCoverage(householdId: string, bookId: string, periodId: string): Promise<unknown> {
    const result = await this.client.query(
      `SELECT period.period_id AS "periodId", period.state AS "periodStatus",
        COALESCE(
          jsonb_agg(DISTINCT reconciliation.reconciliation_id)
            FILTER (WHERE reconciliation.reconciliation_id IS NOT NULL),
          '[]'::jsonb
        ) AS "reconciliationIds",
        COALESCE(
          jsonb_agg(DISTINCT discrepancy.item ->> 'discrepancyId')
            FILTER (WHERE discrepancy.item ->> 'discrepancyId' IS NOT NULL),
          '[]'::jsonb
        ) AS "unresolvedDiscrepancyIds",
        COALESCE(
          jsonb_agg(DISTINCT artifact.artifact_id)
            FILTER (WHERE artifact.artifact_id IS NOT NULL),
          '[]'::jsonb
        ) AS "responsibleArtifactIds"
       FROM accounting.periods period
       JOIN operations.households household ON household.id = period.household_id
       JOIN accounting.books book ON book.id = period.book_id
       LEFT JOIN accounting.reconciliations reconciliation
         ON reconciliation.household_id = period.household_id
        AND reconciliation.book_id = period.book_id
        AND reconciliation.period_start = period.period_start
        AND reconciliation.period_end = period.period_end
       LEFT JOIN LATERAL jsonb_array_elements(reconciliation.unresolved_discrepancies) discrepancy(item)
         ON true
       LEFT JOIN LATERAL (
         SELECT artifact.artifact_id
         FROM accounting.reconciliation_evidence link
         JOIN operations.artifacts artifact ON artifact.id = link.artifact_id
         WHERE link.reconciliation_id = reconciliation.id
       ) artifact ON true
       WHERE household.household_id = $1 AND book.book_id = $2 AND period.period_id = $3
       GROUP BY period.period_id, period.state`,
      [householdId, bookId, periodId],
    );
    return this.one(result.rows[0], 'period_coverage_not_found');
  }

  private one<T>(row: T | undefined, code: string): T {
    if (row === undefined) this.fail(code);
    return row;
  }

  private fail(code: string): never {
    throw new PlusOneError({
      category: 'constraint_violation',
      code,
      message: 'Reconciliation repository operation failed',
      retry: 'after_state_resolution',
      receiptLookupRequired: false,
      details: {},
    });
  }
}
