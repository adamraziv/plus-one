import { z } from 'zod';
import {
  AccountingClassSchemaV1,
  CurrencyCodeSchema,
  NormalBalanceSchemaV1,
} from '@plus-one/contracts';
import { JournalWorkRequestSchemaV1 } from '@plus-one/accounting';

const nonEmptyText = z.string().min(1).max(4_000);

export const TransactionCaptureRequestDraftSchemaV1 = z.object({
  schemaName: z.literal('transaction-capture-request-draft'),
  schemaVersion: z.literal(1),
  instruction: nonEmptyText.describe('Original user instruction, preserving account and category names exactly.'),
  known: z.object({
    amount: z.string().min(1).max(128).optional()
      .describe('Decimal amount from the user, without a currency symbol.'),
    currency: CurrencyCodeSchema.optional()
      .describe('Uppercase currency code explicitly stated or unambiguous from the request.'),
    paymentAccountName: z.string().min(1).max(512).optional()
      .describe('User-provided payment account name, not a ledger account id.'),
    occurredOn: z.string().min(1).max(64).optional()
      .describe('Transaction date from the user. Prefer YYYY-MM-DD when stated.'),
    categoryName: z.string().min(1).max(512).optional()
      .describe('User-provided category name, not a ledger account id.'),
  }).strict().default({}),
}).strict().describe('Semantic draft for an explicit transaction capture request.');

export const JournalWorkRequestDraftSchemaV1 = z.object({
  schemaName: z.literal('journal-work-request-draft'),
  schemaVersion: z.literal(1),
  operation: JournalWorkRequestSchemaV1.shape.operation,
  instruction: nonEmptyText,
}).strict();

export const ChartWorkRequestDraftSchemaV1 = z.object({
  schemaName: z.literal('chart-work-request-draft'),
  schemaVersion: z.literal(1),
  action: z.enum([
    'create_account', 'update_account', 'archive_account',
    'create_source_mapping', 'replace_source_mapping',
  ]),
  instruction: nonEmptyText,
  known: z.object({
    accountName: z.string().min(1).max(512).optional(),
    parentAccountName: z.string().min(1).max(512).optional(),
    purpose: z.string().min(1).max(2_000).optional(),
    accountingClass: AccountingClassSchemaV1.optional(),
    normalBalance: NormalBalanceSchemaV1.optional(),
    nativeCurrency: CurrencyCodeSchema.optional(),
    ownershipLabel: z.string().min(1).max(2_000).optional(),
    sourceSystem: z.string().min(1).max(128).optional(),
    externalAccountId: z.string().min(1).max(512).optional(),
  }).strict().default({}),
}).strict();

export const IngestionWorkRequestDraftSchemaV1 = z.object({
  schemaName: z.literal('ingestion-work-request-draft'),
  schemaVersion: z.literal(1),
  instruction: nonEmptyText,
  sourceReference: z.object({
    attachmentLabel: z.string().min(1).max(512).optional(),
    sourceSystem: z.string().min(1).max(128).optional(),
  }).strict().default({}),
}).strict();

export const ReconciliationWorkRequestDraftSchemaV1 = z.object({
  schemaName: z.literal('reconciliation-work-request-draft'),
  schemaVersion: z.literal(1),
  instruction: nonEmptyText,
  accountName: z.string().min(1).max(512),
  statementReference: z.string().min(1).max(1_000),
  requestedOperation: z.enum(['reconcile', 'close_period', 'reopen_period']),
}).strict();

export type TransactionCaptureRequestDraftV1 = z.infer<typeof TransactionCaptureRequestDraftSchemaV1>;
export type JournalWorkRequestDraftV1 = z.infer<typeof JournalWorkRequestDraftSchemaV1>;
export type ChartWorkRequestDraftV1 = z.infer<typeof ChartWorkRequestDraftSchemaV1>;
export type IngestionWorkRequestDraftV1 = z.infer<typeof IngestionWorkRequestDraftSchemaV1>;
export type ReconciliationWorkRequestDraftV1 = z.infer<typeof ReconciliationWorkRequestDraftSchemaV1>;
