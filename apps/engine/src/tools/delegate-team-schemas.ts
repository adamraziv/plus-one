import { z } from 'zod';
import {
  EvidenceRequestSchemaV1,
  JsonValueSchema,
  type JsonValue,
} from '@plus-one/contracts';
import { AccountingDelegateRequestSchemaV1 } from '../accounting/accounting-lead-contracts.js';
import {
  type TransactionCaptureRequestDraftV1,
} from '../accounting/accounting-request-drafts.js';

const jsonObjectSchema = z.record(z.string(), JsonValueSchema);
const TeamIdSchema = z.enum([
  'query',
  'accounting',
  'budgeting',
  'cash-flow',
  'investments-retirement',
  'records-reporting',
]);

export { AccountingDelegateRequestSchemaV1 } from '../accounting/accounting-lead-contracts.js';
export { TransactionCaptureRequestDraftSchemaV1 } from '../accounting/accounting-request-drafts.js';

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

export const DelegateTeamToolInputSchema = z.object({
  team: TeamIdSchema.describe([
    'Exact registered specialist team id.',
    'Use query for checked reads of household finance data.',
    'Use accounting for transaction capture, journal, chart, ingestion, or reconciliation work.',
  ].join(' ')),
  request: z.union([
    QueryDelegateRequestSchemaV1,
    AccountingDelegateRequestSchemaV1,
    jsonObjectSchema,
  ]).describe([
    'JSON object for the selected team.',
    'For query, use query-lead-request-draft or full EvidenceRequestV1.',
    'For accounting, use AccountingLeadRequestV1; transaction_capture must contain transaction-capture-request-draft or TransactionCaptureRequestV1.',
  ].join(' ')),
}).strict().superRefine((value, context) => {
  const schema = value.team === 'query'
    ? QueryDelegateRequestSchemaV1
    : value.team === 'accounting' ? AccountingDelegateRequestSchemaV1 : undefined;
  if (schema === undefined || schema.safeParse(value.request).success) return;
  context.addIssue({
    code: 'custom',
    path: ['request'],
    message: `Request does not match the ${value.team} team contract.`,
  });
}).describe('Delegate exactly one user task to the specialist team matching the user intent.');

export type { TransactionCaptureRequestDraftV1 };

export function parseDelegateTeamToolInput(input: unknown) {
  return DelegateTeamToolInputSchema.parse(input);
}

export function requestForRuntime(request: unknown): JsonValue {
  return JSON.parse(JSON.stringify(request)) as JsonValue;
}
