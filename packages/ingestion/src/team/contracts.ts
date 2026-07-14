import { z } from 'zod';
import {
  AccountIdSchema, ArtifactEnvelopeSchemaV1, BookIdSchema, HouseholdIdSchema,
} from '@plus-one/contracts';
import {
  ConfirmImportBatchProposalSchemaV1, ImportBatchIdSchema,
  NormalizedRowIdSchema,
  ReconciliationProposalSchemaV1, StatementSnapshotIdSchema,
  PeriodCloseProposalSchemaV1, PeriodReopenProposalSchemaV1,
} from '../contracts.js';

export const IngestionWorkRequestSchemaV1 = z.object({
  schemaName: z.literal('ingestion-work-request'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  importBatchId: ImportBatchIdSchema,
  checkedSourceArtifact: ArtifactEnvelopeSchemaV1,
}).strict();
export type IngestionWorkRequestV1 = z.infer<typeof IngestionWorkRequestSchemaV1>;

export const IngestionClarificationSchemaV1 = z.object({
  schemaName: z.literal('ingestion-clarification'),
  schemaVersion: z.literal(1),
  unresolvedNormalizedRowIds: z.array(NormalizedRowIdSchema).min(1),
  questions: z.array(z.string().min(1).max(2_000)).min(1),
  reason: z.string().min(1).max(2_000),
}).strict();
export type IngestionClarificationV1 = z.infer<typeof IngestionClarificationSchemaV1>;

export const IngestionWorkResultSchemaV1 = z.union([
  ConfirmImportBatchProposalSchemaV1, IngestionClarificationSchemaV1,
]);
export type IngestionWorkResultV1 = z.infer<typeof IngestionWorkResultSchemaV1>;

export const ReconciliationWorkRequestSchemaV1 = z.object({
  schemaName: z.literal('reconciliation-work-request'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  bookId: BookIdSchema,
  accountId: AccountIdSchema,
  statementSnapshotId: StatementSnapshotIdSchema,
  checkedEvidenceArtifacts: z.array(ArtifactEnvelopeSchemaV1).min(1),
  requestedOperation: z.enum(['reconcile', 'close_period', 'reopen_period']),
}).strict();
export type ReconciliationWorkRequestV1 = z.infer<typeof ReconciliationWorkRequestSchemaV1>;

export const ReconciliationClarificationSchemaV1 = z.object({
  schemaName: z.literal('reconciliation-clarification'),
  schemaVersion: z.literal(1),
  missingEvidence: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1).max(2_000),
}).strict();
export type ReconciliationClarificationV1 = z.infer<typeof ReconciliationClarificationSchemaV1>;

export const ReconciliationWorkResultSchemaV1 = z.union([
  ReconciliationProposalSchemaV1, PeriodCloseProposalSchemaV1,
  PeriodReopenProposalSchemaV1, ReconciliationClarificationSchemaV1,
]);
export type ReconciliationWorkResultV1 = z.infer<typeof ReconciliationWorkResultSchemaV1>;
