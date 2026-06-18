import { z } from 'zod';
import {
  AccountIdSchema, AccountSourceMappingIdSchema, AccountingClassSchemaV1,
  BookIdSchema, CurrencyCodeSchema, DraftSeriesIdSchema,
  HouseholdIdSchema, JournalDraftIdSchema, JournalIdSchema, NormalBalanceSchemaV1,
  PostJournalProposalSchemaV1,
} from '@plus-one/contracts';

const nonEmpty = z.string().min(1).max(4_000);
const optionalText = z.string().min(1).max(2_000).optional();

export const AccountingLeadRequestSchemaV1 = z.object({
  schemaName: z.literal('accounting-lead-request'),
  schemaVersion: z.literal(1),
  intent: z.enum(['transaction_capture', 'ingestion', 'journal', 'chart_of_accounts', 'reconciliation']),
  request: z.json(),
}).strict();

export const TransactionCaptureRequestSchemaV1 = z.object({
  schemaName: z.literal('transaction-capture-request'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  bookId: BookIdSchema,
  explicitInstruction: z.literal(true),
  instruction: nonEmpty,
  known: z.object({
    amount: z.string().optional(),
    currency: CurrencyCodeSchema.optional(),
    paymentAccountId: AccountIdSchema.optional(),
    occurredOn: z.string().optional(),
    categoryAccountId: AccountIdSchema.optional(),
  }).strict(),
}).strict();

export const JournalWorkRequestSchemaV1 = z.object({
  schemaName: z.literal('journal-work-request'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  bookId: BookIdSchema,
  operation: z.enum(['post', 'transfer', 'split', 'adjustment', 'reverse_replace', 'fx_realized']),
  instruction: nonEmpty,
}).strict();

export const ChartWorkRequestSchemaV1 = z.object({
  schemaName: z.literal('chart-work-request'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  bookId: BookIdSchema,
  instruction: nonEmpty,
}).strict();

export const AccountingClarificationSchemaV1 = z.object({
  schemaName: z.literal('accounting-clarification'),
  schemaVersion: z.literal(1),
  missingFields: z.array(z.enum([
    'amount', 'payment_account', 'currency', 'occurred_on', 'category', 'exchange_rate',
  ])).min(1),
  questions: z.array(nonEmpty).min(1),
  reason: nonEmpty,
}).strict();

export const CheckedJournalDraftProposalSchemaV1 = z.object({
  draftSeriesId: DraftSeriesIdSchema,
  version: z.number().int().positive(),
  previousDraftId: JournalDraftIdSchema.optional(),
  journal: PostJournalProposalSchemaV1,
}).strict().superRefine((draft, context) => {
  const hasPrevious = draft.previousDraftId !== undefined;
  if (draft.version === 1 ? hasPrevious : !hasPrevious) {
    context.addIssue({
      code: 'custom',
      message: 'Draft version and previousDraftId are inconsistent',
    });
  }
});

const postMutation = z.object({
  schemaName: z.literal('accounting-journal-mutation-proposal'),
  schemaVersion: z.literal(1),
  operation: z.literal('post'),
  draft: CheckedJournalDraftProposalSchemaV1,
}).strict();

const correctionMutation = z.object({
  schemaName: z.literal('accounting-journal-mutation-proposal'),
  schemaVersion: z.literal(1),
  operation: z.literal('reverse_replace'),
  originalJournalId: JournalIdSchema,
  reversal: CheckedJournalDraftProposalSchemaV1,
  replacement: CheckedJournalDraftProposalSchemaV1,
}).strict().superRefine((proposal, context) => {
  const reversal = proposal.reversal.journal;
  const replacement = proposal.replacement.journal;
  if (reversal.householdId !== replacement.householdId
    || reversal.bookId !== replacement.bookId
    || reversal.taskId !== replacement.taskId) {
    context.addIssue({
      code: 'custom',
      message: 'Correction journals must share household, book, and task',
    });
  }
  if (reversal.journalId === replacement.journalId
    || reversal.draftId === replacement.draftId) {
    context.addIssue({
      code: 'custom',
      message: 'Correction journals and drafts require distinct identities',
    });
  }
  if (reversal.journalType !== 'reversal'
    || reversal.reversesJournalId !== proposal.originalJournalId) {
    context.addIssue({
      code: 'custom',
      message: 'Reversal must identify the original journal',
    });
  }
  if (replacement.journalType !== 'replacement'
    || replacement.replacesJournalId !== proposal.originalJournalId) {
    context.addIssue({
      code: 'custom',
      message: 'Replacement must identify the original journal',
    });
  }
});

export const AccountingJournalMutationProposalSchemaV1 = z.discriminatedUnion(
  'operation',
  [postMutation, correctionMutation],
);

export const AccountingWorkResultSchemaV1 = z.discriminatedUnion('schemaName', [
  AccountingJournalMutationProposalSchemaV1,
  AccountingClarificationSchemaV1,
]);

const accountFields = {
  householdId: HouseholdIdSchema,
  bookId: BookIdSchema,
  accountId: AccountIdSchema,
  parentAccountId: AccountIdSchema.optional(),
  name: nonEmpty,
  purpose: optionalText,
  accountingClass: AccountingClassSchemaV1,
  normalBalance: NormalBalanceSchemaV1,
  nativeCurrency: CurrencyCodeSchema,
  ownershipLabel: optionalText,
};

const mappingFields = {
  householdId: HouseholdIdSchema,
  bookId: BookIdSchema,
  mappingId: AccountSourceMappingIdSchema,
  accountId: AccountIdSchema,
  sourceSystem: z.string().min(1).max(128),
  externalAccountId: z.string().min(1).max(512),
  metadata: z.record(z.string(), z.json()),
};

export const ChartOfAccountsProposalSchemaV1 = z.discriminatedUnion('action', [
  z.object({
    schemaName: z.literal('chart-of-accounts-proposal'),
    schemaVersion: z.literal(1),
    action: z.literal('create_account'),
    ...accountFields,
  }).strict(),
  z.object({
    schemaName: z.literal('chart-of-accounts-proposal'),
    schemaVersion: z.literal(1),
    action: z.literal('update_account'),
    ...accountFields,
  }).strict(),
  z.object({
    schemaName: z.literal('chart-of-accounts-proposal'),
    schemaVersion: z.literal(1),
    action: z.literal('archive_account'),
    householdId: HouseholdIdSchema,
    bookId: BookIdSchema,
    accountId: AccountIdSchema,
  }).strict(),
  z.object({
    schemaName: z.literal('chart-of-accounts-proposal'),
    schemaVersion: z.literal(1),
    action: z.literal('create_source_mapping'),
    ...mappingFields,
  }).strict(),
  z.object({
    schemaName: z.literal('chart-of-accounts-proposal'),
    schemaVersion: z.literal(1),
    action: z.literal('replace_source_mapping'),
    archivedMappingId: AccountSourceMappingIdSchema,
    ...mappingFields,
  }).strict(),
]);

export type AccountingLeadRequestV1 = z.infer<typeof AccountingLeadRequestSchemaV1>;
export type TransactionCaptureRequestV1 = z.infer<typeof TransactionCaptureRequestSchemaV1>;
export type JournalWorkRequestV1 = z.infer<typeof JournalWorkRequestSchemaV1>;
export type ChartWorkRequestV1 = z.infer<typeof ChartWorkRequestSchemaV1>;
export type AccountingClarificationV1 = z.infer<typeof AccountingClarificationSchemaV1>;
export type CheckedJournalDraftProposalV1 = z.infer<typeof CheckedJournalDraftProposalSchemaV1>;
export type AccountingJournalMutationProposalV1 =
  z.infer<typeof AccountingJournalMutationProposalSchemaV1>;
export type AccountingWorkResultV1 = z.infer<typeof AccountingWorkResultSchemaV1>;
export type ChartOfAccountsProposalV1 = z.infer<typeof ChartOfAccountsProposalSchemaV1>;
