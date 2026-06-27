import { z } from 'zod';
import {
  AccountingLeadRequestSchemaV1,
  TransactionCaptureRequestSchemaV1,
} from '@plus-one/accounting';
import {
  CurrencyCodeSchema,
  EvidenceRequestSchemaV1,
  JsonValueSchema,
  type JsonValue,
} from '@plus-one/contracts';

const jsonObjectSchema = z.record(z.string(), JsonValueSchema);
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

export const AccountingDelegateRequestSchemaV1 = AccountingLeadRequestSchemaV1.extend({
  request: z.union([
    TransactionCaptureRequestSchemaV1,
    TransactionCaptureRequestDraftSchemaV1,
    jsonObjectSchema,
  ]),
}).describe('AccountingLeadRequestV1 for explicit accounting work.');

export const QueryLeadRequestDraftSchemaV1 = z.object({
  schemaName: z.literal('query-lead-request-draft'),
  schemaVersion: z.literal(1),
  businessQuestion: z.string().min(1).max(2_000)
    .describe('Finance question to answer from checked household evidence.'),
  timeframe: z.object({
    start: z.string().min(1).max(64).describe('Inclusive start date. Prefer YYYY-MM-DD.'),
    end: z.string().min(1).max(64).describe('Inclusive end date. Prefer YYYY-MM-DD.'),
  }).strict().optional(),
  desiredGrain: z.array(z.string().min(1).max(128)).min(1).max(16).optional()
    .describe('Semantic result grain such as household, account, category, journal, goal, or source.'),
  requiredCalculations: z.array(z.string().min(1).max(512)).max(32).default([])
    .describe('Calculations explicitly requested by the user.'),
  coverage: z.array(z.string().min(1).max(512)).min(1).max(32).optional()
    .describe('Evidence coverage needed to answer the user.'),
}).strict().describe('Semantic draft for a checked household finance read question.');

export const QueryDelegateRequestSchemaV1 = z.union([
  EvidenceRequestSchemaV1,
  QueryLeadRequestDraftSchemaV1,
]).describe('Full EvidenceRequestV1 or semantic query draft.');

const futureTeamRequestSchema = jsonObjectSchema.describe('Typed request object for this specialist team.');

export const DelegateTeamToolInputSchema = z.discriminatedUnion('team', [
  z.object({
    team: z.literal('query').describe('Use for checked reads of household finance data.'),
    request: QueryDelegateRequestSchemaV1,
  }).strict(),
  z.object({
    team: z.literal('accounting').describe('Use for transaction capture, journal, chart, ingestion, or reconciliation mutations.'),
    request: AccountingDelegateRequestSchemaV1,
  }).strict(),
  z.object({ team: z.literal('budgeting'), request: futureTeamRequestSchema }).strict(),
  z.object({ team: z.literal('cash-flow'), request: futureTeamRequestSchema }).strict(),
  z.object({ team: z.literal('investments-retirement'), request: futureTeamRequestSchema }).strict(),
  z.object({ team: z.literal('records-reporting'), request: futureTeamRequestSchema }).strict(),
]).describe('Delegate exactly one user task to the specialist team matching the user intent.');

export type TransactionCaptureRequestDraftV1 = z.infer<typeof TransactionCaptureRequestDraftSchemaV1>;

export function parseDelegateTeamToolInput(input: unknown) {
  return DelegateTeamToolInputSchema.parse(input);
}

export function requestForRuntime(request: unknown): JsonValue {
  return JSON.parse(JSON.stringify(request)) as JsonValue;
}
