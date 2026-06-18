import { z } from 'zod';
import { ArtifactIdSchema, HouseholdIdSchema, TaskIdSchema } from './ids.js';
import { CurrencyCodeSchema, DecimalStringSchema } from './money.js';
import { LocalDateSchema } from './time.js';

function opaqueId(prefix: string) {
  return z.string().regex(new RegExp('^' + prefix + '_[0-9A-HJKMNP-TV-Z]{26}$'));
}

export const BookIdSchema = opaqueId('book').brand<'BookId'>();
export const BookConfigurationIdSchema = opaqueId('bookconfig').brand<'BookConfigurationId'>();
export const AccountIdSchema = opaqueId('account').brand<'AccountId'>();
export const AccountSourceMappingIdSchema = opaqueId('accountmap')
  .brand<'AccountSourceMappingId'>();
export const PeriodIdSchema = opaqueId('period').brand<'PeriodId'>();
export const DraftSeriesIdSchema = opaqueId('draftseries').brand<'DraftSeriesId'>();
export const JournalDraftIdSchema = opaqueId('draft').brand<'JournalDraftId'>();
export const JournalIdSchema = opaqueId('journal').brand<'JournalId'>();
export const PostingIdSchema = opaqueId('posting').brand<'PostingId'>();
export const CounterpartyIdSchema = opaqueId('counterparty').brand<'CounterpartyId'>();
export const TagIdSchema = opaqueId('tag').brand<'TagId'>();

export type BookId = z.infer<typeof BookIdSchema>;
export type BookConfigurationId = z.infer<typeof BookConfigurationIdSchema>;
export type AccountId = z.infer<typeof AccountIdSchema>;
export type AccountSourceMappingId = z.infer<typeof AccountSourceMappingIdSchema>;
export type PeriodId = z.infer<typeof PeriodIdSchema>;
export type DraftSeriesId = z.infer<typeof DraftSeriesIdSchema>;
export type JournalDraftId = z.infer<typeof JournalDraftIdSchema>;
export type JournalId = z.infer<typeof JournalIdSchema>;
export type PostingId = z.infer<typeof PostingIdSchema>;
export type CounterpartyId = z.infer<typeof CounterpartyIdSchema>;
export type TagId = z.infer<typeof TagIdSchema>;

export const AccountingClassSchemaV1 = z.enum(['asset', 'liability', 'equity', 'income', 'expense']);
export const NormalBalanceSchemaV1 = z.enum(['debit', 'credit']);
export const PostingDirectionSchemaV1 = z.enum(['debit', 'credit']);
export const JournalTypeSchemaV1 = z.enum([
  'ordinary', 'transfer', 'reversal', 'replacement', 'adjustment', 'fx_realized',
]);
export const ExchangeRateQuoteSchemaV1 = z.enum(['native_per_transaction', 'transaction_per_native']);

const unsignedDecimal = /^\d+(?:\.\d+)?$/;
export const NonNegativeAmountStringSchema = DecimalStringSchema.refine(
  (value) => unsignedDecimal.test(value), 'Expected a non-negative decimal string',
);
export const PositiveAmountStringSchema = NonNegativeAmountStringSchema.refine(
  (value) => !/^0+(?:\.0+)?$/.test(value), 'Expected a positive decimal string',
);
export const PositiveExchangeRateSchema = PositiveAmountStringSchema;

export const DraftPostingInputSchemaV1 = z.object({
  accountId: AccountIdSchema,
  direction: PostingDirectionSchemaV1,
  transactionAmount: NonNegativeAmountStringSchema,
  accountNativeAmount: NonNegativeAmountStringSchema,
  accountNativeCurrency: CurrencyCodeSchema,
  exchangeRate: PositiveExchangeRateSchema.optional(),
  exchangeRateQuote: ExchangeRateQuoteSchemaV1.optional(),
  exchangeRateDate: LocalDateSchema.optional(),
  exchangeRateSource: z.string().min(1).max(256).optional(),
  memo: z.string().max(2_000).optional(),
  tagIds: z.array(TagIdSchema).max(32).default([]),
}).strict().superRefine((posting, context) => {
  const rateFields = [posting.exchangeRate, posting.exchangeRateQuote,
    posting.exchangeRateDate, posting.exchangeRateSource];
  const supplied = rateFields.filter((field) => field !== undefined).length;
  if (supplied !== 0 && supplied !== rateFields.length) {
    context.addIssue({ code: 'custom', message: 'Exchange-rate fields must be all present or all absent' });
  }
});

export const PostedPostingInputSchemaV1 = z.object({
  accountId: AccountIdSchema,
  direction: PostingDirectionSchemaV1,
  transactionAmount: PositiveAmountStringSchema,
  accountNativeAmount: PositiveAmountStringSchema,
  accountNativeCurrency: CurrencyCodeSchema,
  exchangeRate: PositiveExchangeRateSchema.optional(),
  exchangeRateQuote: ExchangeRateQuoteSchemaV1.optional(),
  exchangeRateDate: LocalDateSchema.optional(),
  exchangeRateSource: z.string().min(1).max(256).optional(),
  memo: z.string().max(2_000).optional(),
  tagIds: z.array(TagIdSchema).max(32).default([]),
  postingId: PostingIdSchema,
}).strict().superRefine((posting, context) => {
  const rateFields = [posting.exchangeRate, posting.exchangeRateQuote,
    posting.exchangeRateDate, posting.exchangeRateSource];
  const supplied = rateFields.filter((field) => field !== undefined).length;
  if (supplied !== 0 && supplied !== rateFields.length) {
    context.addIssue({ code: 'custom', message: 'Exchange-rate fields must be all present or all absent' });
  }
});

export const JournalDraftInputSchemaV1 = z.object({
  schemaName: z.literal('journal-draft-input'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  bookId: BookIdSchema,
  draftId: JournalDraftIdSchema,
  draftSeriesId: DraftSeriesIdSchema,
  version: z.number().int().positive(),
  previousDraftId: JournalDraftIdSchema.optional(),
  taskId: TaskIdSchema,
  checkedArtifactId: ArtifactIdSchema,
  checkedArtifactHash: z.string().regex(/^[0-9a-f]{64}$/),
  journalType: JournalTypeSchemaV1,
  transactionCurrency: CurrencyCodeSchema,
  occurredOn: LocalDateSchema,
  effectiveOn: LocalDateSchema,
  settlementOn: LocalDateSchema.optional(),
  sourceOn: LocalDateSchema.optional(),
  description: z.string().min(1).max(4_000),
  counterpartyId: CounterpartyIdSchema.optional(),
  tagIds: z.array(TagIdSchema).max(32).default([]),
  postings: z.array(DraftPostingInputSchemaV1).min(1),
}).strict().superRefine((draft, context) => {
  if (draft.version === 1 && draft.previousDraftId !== undefined) {
    context.addIssue({ code: 'custom', message: 'Version 1 cannot reference a previous draft' });
  }
  if (draft.version > 1 && draft.previousDraftId === undefined) {
    context.addIssue({ code: 'custom', message: 'Revised drafts require previousDraftId' });
  }
});

export const PostJournalInputSchemaV1 = z.object({
  schemaName: z.literal('post-journal-input'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  bookId: BookIdSchema,
  journalId: JournalIdSchema,
  draftId: JournalDraftIdSchema,
  periodId: PeriodIdSchema,
  taskId: TaskIdSchema,
  checkedArtifactId: ArtifactIdSchema,
  checkedArtifactHash: z.string().regex(/^[0-9a-f]{64}$/),
  journalType: JournalTypeSchemaV1,
  transactionCurrency: CurrencyCodeSchema,
  occurredOn: LocalDateSchema,
  effectiveOn: LocalDateSchema,
  settlementOn: LocalDateSchema.optional(),
  sourceOn: LocalDateSchema.optional(),
  description: z.string().min(1).max(4_000),
  counterpartyId: CounterpartyIdSchema.optional(),
  tagIds: z.array(TagIdSchema).max(32).default([]),
  reversesJournalId: JournalIdSchema.optional(),
  replacesJournalId: JournalIdSchema.optional(),
  postings: z.array(DraftPostingInputSchemaV1).min(2),
}).strict().superRefine((journal, context) => {
  for (const posting of journal.postings) {
    if (PositiveAmountStringSchema.safeParse(posting.transactionAmount).success === false) {
      context.addIssue({ code: 'custom', path: ['postings'],
        message: 'Posted postings require a positive transaction amount' });
    }
    if (PositiveAmountStringSchema.safeParse(posting.accountNativeAmount).success === false) {
      context.addIssue({ code: 'custom', path: ['postings'],
        message: 'Posted postings require a positive account native amount' });
    }
    const crossCurrency = posting.accountNativeCurrency !== journal.transactionCurrency;
    if (crossCurrency && posting.exchangeRate === undefined) {
      context.addIssue({ code: 'custom', message: 'Cross-currency postings require rate provenance' });
    }
    if (!crossCurrency && posting.exchangeRate !== undefined) {
      context.addIssue({ code: 'custom', message: 'Same-currency postings cannot carry exchange-rate fields' });
    }
  }
  if (journal.journalType === 'reversal' && journal.reversesJournalId === undefined) {
    context.addIssue({ code: 'custom', message: 'Reversal journals require reversesJournalId' });
  }
  if (journal.journalType === 'replacement' && journal.replacesJournalId === undefined) {
    context.addIssue({ code: 'custom', message: 'Replacement journals require replacesJournalId' });
  }
});

export const PostJournalProposalSchemaV1 = z.object({
  schemaName: z.literal('post-journal-proposal'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  bookId: BookIdSchema,
  journalId: JournalIdSchema,
  draftId: JournalDraftIdSchema,
  periodId: PeriodIdSchema,
  taskId: TaskIdSchema,
  journalType: JournalTypeSchemaV1,
  transactionCurrency: CurrencyCodeSchema,
  occurredOn: LocalDateSchema,
  effectiveOn: LocalDateSchema,
  settlementOn: LocalDateSchema.optional(),
  sourceOn: LocalDateSchema.optional(),
  description: z.string().min(1).max(4_000),
  counterpartyId: CounterpartyIdSchema.optional(),
  tagIds: z.array(TagIdSchema).max(32).default([]),
  reversesJournalId: JournalIdSchema.optional(),
  replacesJournalId: JournalIdSchema.optional(),
  postings: z.array(DraftPostingInputSchemaV1).min(2),
}).strict();

export const ReverseAndReplaceInputSchemaV1 = z.object({
  originalJournalId: JournalIdSchema,
  reversal: PostJournalInputSchemaV1,
  replacement: PostJournalInputSchemaV1,
}).strict().superRefine((input, context) => {
  if (input.reversal.journalId === input.replacement.journalId) {
    context.addIssue({ code: 'custom', message: 'Reversal and replacement require distinct journal IDs' });
  }
  if (input.reversal.journalType !== 'reversal'
    || input.reversal.reversesJournalId !== input.originalJournalId) {
    context.addIssue({ code: 'custom', message: 'Reversal must identify the original journal' });
  }
  if (input.replacement.journalType !== 'replacement'
    || input.replacement.replacesJournalId !== input.originalJournalId) {
    context.addIssue({ code: 'custom', message: 'Replacement must identify the original journal' });
  }
});

export type AccountingClassV1 = z.infer<typeof AccountingClassSchemaV1>;
export type NormalBalanceV1 = z.infer<typeof NormalBalanceSchemaV1>;
export type PostingDirectionV1 = z.infer<typeof PostingDirectionSchemaV1>;
export type JournalTypeV1 = z.infer<typeof JournalTypeSchemaV1>;
export type ExchangeRateQuoteV1 = z.infer<typeof ExchangeRateQuoteSchemaV1>;
export type DraftPostingInputV1 = z.infer<typeof DraftPostingInputSchemaV1>;
export type PostedPostingInputV1 = z.infer<typeof PostedPostingInputSchemaV1>;
export type JournalDraftInputV1 = z.infer<typeof JournalDraftInputSchemaV1>;
export type PostJournalProposalV1 = z.infer<typeof PostJournalProposalSchemaV1>;
export type PostJournalInputV1 = z.infer<typeof PostJournalInputSchemaV1>;
export type ReverseAndReplaceInputV1 = z.infer<typeof ReverseAndReplaceInputSchemaV1>;
