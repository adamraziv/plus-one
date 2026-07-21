import { z } from 'zod';
import {
  AccountingIntentSchemaV1,
  ChartWorkRequestSchemaV1,
  JournalWorkRequestSchemaV1,
  TransactionCaptureRequestSchemaV1,
} from '@plus-one/accounting';
import {
  IngestionWorkRequestSchemaV1,
  ReconciliationWorkRequestSchemaV1,
} from '@plus-one/ingestion';
import {
  ChartWorkRequestDraftSchemaV1,
  IngestionWorkRequestDraftSchemaV1,
  JournalWorkRequestDraftSchemaV1,
  ReconciliationWorkRequestDraftSchemaV1,
  TransactionCaptureRequestDraftSchemaV1,
} from './accounting-request-drafts.js';

const leadRequestBase = {
  schemaName: z.literal('accounting-lead-request'),
  schemaVersion: z.literal(1),
};

const transactionCaptureDelegateRequestSchema = z.object({
  ...leadRequestBase,
  intent: z.literal('transaction_capture'),
  request: z.union([TransactionCaptureRequestDraftSchemaV1, TransactionCaptureRequestSchemaV1]),
}).strict();

const ingestionDelegateRequestSchema = z.object({
  ...leadRequestBase,
  intent: z.literal('ingestion'),
  request: z.union([IngestionWorkRequestDraftSchemaV1, IngestionWorkRequestSchemaV1]),
}).strict();

const journalDelegateRequestSchema = z.object({
  ...leadRequestBase,
  intent: z.literal('journal'),
  request: z.union([JournalWorkRequestDraftSchemaV1, JournalWorkRequestSchemaV1]),
}).strict();

const chartDelegateRequestSchema = z.object({
  ...leadRequestBase,
  intent: z.literal('chart_of_accounts'),
  request: z.union([ChartWorkRequestDraftSchemaV1, ChartWorkRequestSchemaV1]),
}).strict();

const reconciliationDelegateRequestSchema = z.object({
  ...leadRequestBase,
  intent: z.literal('reconciliation'),
  request: z.union([ReconciliationWorkRequestDraftSchemaV1, ReconciliationWorkRequestSchemaV1]),
}).strict();

export const AccountingDelegateRequestSchemaV1 = z.discriminatedUnion('intent', [
  transactionCaptureDelegateRequestSchema,
  ingestionDelegateRequestSchema,
  journalDelegateRequestSchema,
  chartDelegateRequestSchema,
  reconciliationDelegateRequestSchema,
]).describe('Typed Accounting Lead request for explicit accounting work.');

export const MaterializedAccountingLeadRequestSchemaV1 = z.discriminatedUnion('intent', [
  z.object({ ...leadRequestBase, intent: z.literal('transaction_capture'), request: TransactionCaptureRequestSchemaV1 }).strict(),
  z.object({ ...leadRequestBase, intent: z.literal('ingestion'), request: IngestionWorkRequestSchemaV1 }).strict(),
  z.object({ ...leadRequestBase, intent: z.literal('journal'), request: JournalWorkRequestSchemaV1 }).strict(),
  z.object({ ...leadRequestBase, intent: z.literal('chart_of_accounts'), request: ChartWorkRequestSchemaV1 }).strict(),
  z.object({ ...leadRequestBase, intent: z.literal('reconciliation'), request: ReconciliationWorkRequestSchemaV1 }).strict(),
]);

export { AccountingIntentSchemaV1 };
export type AccountingIntentV1 = z.infer<typeof AccountingIntentSchemaV1>;
export type AccountingDelegateRequestV1 = z.infer<typeof AccountingDelegateRequestSchemaV1>;
export type MaterializedAccountingLeadRequestV1 = z.infer<typeof MaterializedAccountingLeadRequestSchemaV1>;
