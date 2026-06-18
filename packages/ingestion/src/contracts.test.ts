import { describe, expect, it } from 'vitest';
import {
  ImportBatchStateSchemaV1, ImportRowDecisionSchemaV1,
  ConfirmImportBatchProposalSchemaV1, ReconciliationProposalSchemaV1,
  PeriodCloseProposalSchemaV1, PeriodReopenProposalSchemaV1,
} from './contracts.js';

describe('ingestion and reconciliation contracts', () => {
  it('accepts only explicit import lifecycle states', () => {
    expect(ImportBatchStateSchemaV1.parse('awaiting_confirmation')).toBe('awaiting_confirmation');
    expect(ImportBatchStateSchemaV1.safeParse('complete').success).toBe(false);
  });

  it('retains an explicit per-row decision', () => {
    const decision = ImportRowDecisionSchemaV1.parse({
      normalizedRowId: 'normrow_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      action: 'link_existing',
      existingJournalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      reasonCode: 'probable_duplicate_confirmed',
    });
    expect(decision.action).toBe('link_existing');
  });

  it('requires the proposal to cover at least one row decision', () => {
    expect(ConfirmImportBatchProposalSchemaV1.safeParse({
      schemaName: 'confirm-import-batch-proposal', schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      importBatchId: 'import_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      batchVersion: 1, decisions: [],
    }).success).toBe(false);
  });

  it('keeps reconciliation evidence separate from ledger mutation payloads', () => {
    const proposal = ReconciliationProposalSchemaV1.parse({
      schemaName: 'reconciliation-proposal', schemaVersion: 1,
      reconciliationId: 'recon_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      statementSnapshotId: 'snapshot_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      periodStart: '2026-05-01', periodEnd: '2026-05-31', currency: 'USD',
      ledgerOpeningBalance: '100.00', ledgerClosingBalance: '80.00',
      statementOpeningBalance: '100.00', statementClosingBalance: '80.00',
      evidenceArtifactIds: ['artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K'],
      items: [], unresolvedDiscrepancies: [], completionStatus: 'reconciled',
    });
    expect(proposal).not.toHaveProperty('postings');
  });

  it('requires close and reopen to be separate proposal schemas', () => {
    expect(PeriodCloseProposalSchemaV1.parse({
      schemaName: 'period-close-proposal', schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      periodId: 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      reconciliationIds: ['recon_01JNZQ4A9B8C7D6E5F4G3H2J1K'],
      unresolvedDiscrepancyIds: [], responsibleArtifactIds:
        ['artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K'],
    }).schemaName).toBe('period-close-proposal');
    expect(PeriodReopenProposalSchemaV1.safeParse({
      schemaName: 'period-close-proposal', schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      periodId: 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      reason: 'Correction required', priorCloseEventId: 'periodevent_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    }).success).toBe(false);
  });
});