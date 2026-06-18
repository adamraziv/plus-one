import { z } from 'zod';
import {
  AccountIdSchema, ArtifactIdSchema, BookIdSchema, CurrencyCodeSchema,
  DecimalStringSchema, HouseholdIdSchema, JournalIdSchema, LocalDateSchema,
  PeriodIdSchema, PostJournalProposalSchemaV1,
} from '@plus-one/contracts';

const opaqueId = <const Brand extends string>(prefix: string) => z
  .string()
  .regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`), `Expected ${prefix}_ followed by a ULID`)
  .brand<Brand>();

export const SourceDocumentIdSchema = opaqueId<'SourceDocumentId'>('source');
export const ImportBatchIdSchema = opaqueId<'ImportBatchId'>('import');
export const RawRowIdSchema = opaqueId<'RawRowId'>('rawrow');
export const NormalizedRowIdSchema = opaqueId<'NormalizedRowId'>('normrow');
export const MatchDecisionIdSchema = opaqueId<'MatchDecisionId'>('match');
export const StatementSnapshotIdSchema = opaqueId<'StatementSnapshotId'>('snapshot');
export const StatementLineIdSchema = opaqueId<'StatementLineId'>('stmtline');
export const ReconciliationIdSchema = opaqueId<'ReconciliationId'>('recon');
export const ReconciliationItemIdSchema = opaqueId<'ReconciliationItemId'>('reconitem');
export const PeriodEventIdSchema = opaqueId<'PeriodEventId'>('periodevent');

export type SourceDocumentId = z.infer<typeof SourceDocumentIdSchema>;
export type ImportBatchId = z.infer<typeof ImportBatchIdSchema>;
export type RawRowId = z.infer<typeof RawRowIdSchema>;
export type NormalizedRowId = z.infer<typeof NormalizedRowIdSchema>;
export type MatchDecisionId = z.infer<typeof MatchDecisionIdSchema>;
export type StatementSnapshotId = z.infer<typeof StatementSnapshotIdSchema>;
export type StatementLineId = z.infer<typeof StatementLineIdSchema>;
export type ReconciliationId = z.infer<typeof ReconciliationIdSchema>;
export type ReconciliationItemId = z.infer<typeof ReconciliationItemIdSchema>;
export type PeriodEventId = z.infer<typeof PeriodEventIdSchema>;

export const ContentHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const ImportBatchStateSchemaV1 = z.enum([
  'received', 'extracted', 'normalized', 'checked', 'awaiting_confirmation',
  'approved', 'rejected', 'posting', 'posted', 'partially_posted', 'failed',
]);
export type ImportBatchStateV1 = z.infer<typeof ImportBatchStateSchemaV1>;

export const ImportRowStateSchemaV1 = z.enum([
  'received', 'normalized', 'exact_duplicate', 'probable_duplicate', 'ready',
  'awaiting_confirmation', 'approved', 'linked_existing', 'deferred', 'rejected',
  'posted', 'failed',
]);
export type ImportRowStateV1 = z.infer<typeof ImportRowStateSchemaV1>;

export const ReconciliationItemStatusSchemaV1 = z.enum([
  'matched', 'unmatched', 'duplicate', 'disputed', 'timing_difference',
]);
export type ReconciliationItemStatusV1 = z.infer<typeof ReconciliationItemStatusSchemaV1>;

export const NormalizedTransactionSchemaV1 = z.object({
  occurredOn: LocalDateSchema,
  postedOn: LocalDateSchema.optional(),
  amount: DecimalStringSchema,
  currency: CurrencyCodeSchema,
  description: z.string().min(1).max(2_000),
  counterparty: z.string().max(500).optional(),
  externalTransactionId: z.string().min(1).max(500).optional(),
}).strict();
export type NormalizedTransactionV1 = z.infer<typeof NormalizedTransactionSchemaV1>;

export const ImportRowDecisionSchemaV1 = z.discriminatedUnion('action', [
  z.object({
    normalizedRowId: NormalizedRowIdSchema,
    action: z.literal('post'),
    draft: z.object({
      draftSeriesId: z.string().min(1).max(160),
      version: z.number().int().positive(),
      journal: PostJournalProposalSchemaV1,
    }).strict(),
    reasonCode: z.string().min(1).max(256),
  }).strict(),
  z.object({
    normalizedRowId: NormalizedRowIdSchema,
    action: z.literal('link_existing'),
    existingJournalId: JournalIdSchema,
    reasonCode: z.string().min(1).max(256),
  }).strict(),
  z.object({
    normalizedRowId: NormalizedRowIdSchema,
    action: z.enum(['defer', 'reject']),
    reasonCode: z.string().min(1).max(256),
  }).strict(),
]);
export type ImportRowDecisionV1 = z.infer<typeof ImportRowDecisionSchemaV1>;

export const ConfirmImportBatchProposalSchemaV1 = z.object({
  schemaName: z.literal('confirm-import-batch-proposal'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  importBatchId: ImportBatchIdSchema,
  batchVersion: z.number().int().positive(),
  decisions: z.array(ImportRowDecisionSchemaV1).min(1),
}).strict().superRefine((value, context) => {
  const ids = value.decisions.map((decision) => decision.normalizedRowId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: 'custom',
      message: 'Each normalized row may appear once in a batch proposal',
    });
  }
});
export type ConfirmImportBatchProposalV1 = z.infer<typeof ConfirmImportBatchProposalSchemaV1>;

export const ReconciliationItemProposalSchemaV1 = z.object({
  reconciliationItemId: ReconciliationItemIdSchema,
  statementLineId: StatementLineIdSchema.optional(),
  normalizedRowId: NormalizedRowIdSchema.optional(),
  journalId: JournalIdSchema.optional(),
  status: ReconciliationItemStatusSchemaV1,
  amountDifference: DecimalStringSchema,
  explanation: z.string().max(2_000).optional(),
}).strict();
export type ReconciliationItemProposalV1 = z.infer<typeof ReconciliationItemProposalSchemaV1>;

export const DiscrepancyIdSchema = z.string().regex(/^discrepancy_[0-9A-HJKMNP-TV-Z]{26}$/);

export const ReconciliationProposalSchemaV1 = z.object({
  schemaName: z.literal('reconciliation-proposal'),
  schemaVersion: z.literal(1),
  reconciliationId: ReconciliationIdSchema,
  householdId: HouseholdIdSchema,
  bookId: BookIdSchema,
  accountId: AccountIdSchema,
  statementSnapshotId: StatementSnapshotIdSchema,
  periodStart: LocalDateSchema,
  periodEnd: LocalDateSchema,
  currency: CurrencyCodeSchema,
  ledgerOpeningBalance: DecimalStringSchema,
  ledgerClosingBalance: DecimalStringSchema,
  statementOpeningBalance: DecimalStringSchema,
  statementClosingBalance: DecimalStringSchema,
  evidenceArtifactIds: z.array(ArtifactIdSchema).min(1),
  items: z.array(ReconciliationItemProposalSchemaV1),
  unresolvedDiscrepancies: z.array(z.object({
    discrepancyId: DiscrepancyIdSchema,
    code: z.string().min(1).max(160),
    detail: z.string().min(1).max(2_000),
  }).strict()),
  completionStatus: z.enum(['reconciled', 'reconciled_with_exceptions', 'incomplete']),
}).strict();
export type ReconciliationProposalV1 = z.infer<typeof ReconciliationProposalSchemaV1>;

export const PeriodCloseProposalSchemaV1 = z.object({
  schemaName: z.literal('period-close-proposal'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  bookId: BookIdSchema,
  periodId: PeriodIdSchema,
  reconciliationIds: z.array(ReconciliationIdSchema).min(1),
  unresolvedDiscrepancyIds: z.array(z.string().min(1)),
  responsibleArtifactIds: z.array(ArtifactIdSchema).min(1),
}).strict();
export type PeriodCloseProposalV1 = z.infer<typeof PeriodCloseProposalSchemaV1>;

export const PeriodReopenProposalSchemaV1 = z.object({
  schemaName: z.literal('period-reopen-proposal'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  bookId: BookIdSchema,
  periodId: PeriodIdSchema,
  reason: z.string().min(1).max(2_000),
  priorCloseEventId: PeriodEventIdSchema,
}).strict();
export type PeriodReopenProposalV1 = z.infer<typeof PeriodReopenProposalSchemaV1>;
