import { z } from 'zod';
import {
  EvidenceRequestSchemaV1,
  JsonValueSchema,
  type JsonValue,
} from '@plus-one/contracts';
import {
  BudgetingDelegateRequestSchemaV1,
  BudgetPlanRequestDraftSchemaV1,
  BudgetScenarioRequestDraftSchemaV1,
} from '@plus-one/planning';
import { AccountingDelegateRequestSchemaV1 } from '../accounting/accounting-lead-contracts.js';
import {
  ChartWorkRequestDraftSchemaV1,
  IngestionWorkRequestDraftSchemaV1,
  JournalWorkRequestDraftSchemaV1,
  ReconciliationWorkRequestDraftSchemaV1,
  TransactionCaptureRequestDraftSchemaV1,
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
export { BudgetingDelegateRequestSchemaV1 } from '@plus-one/planning';
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

const optionalIdentity = (schemaName: string) => ({
  schemaName: z.literal(schemaName).optional(),
  schemaVersion: z.literal(1).optional(),
});

const QueryProviderDraftSchemaV1 = QueryLeadRequestDraftSchemaV1.extend(
  optionalIdentity('query-lead-request-draft'),
);

const BudgetingProviderRequestSchemaV1 = z.discriminatedUnion('intent', [
  z.object({
    ...optionalIdentity('budgeting-lead-request'),
    intent: z.literal('budget_plan'),
    request: BudgetPlanRequestDraftSchemaV1.extend(
      optionalIdentity('budget-plan-request-draft'),
    ),
  }).strict(),
  z.object({
    ...optionalIdentity('budgeting-lead-request'),
    intent: z.literal('budget_scenarios'),
    request: BudgetScenarioRequestDraftSchemaV1.extend(
      optionalIdentity('budget-scenario-request-draft'),
    ),
  }).strict(),
]);

const AccountingProviderRequestSchemaV1 = z.discriminatedUnion('intent', [
  z.object({
    ...optionalIdentity('accounting-lead-request'),
    intent: z.literal('transaction_capture'),
    request: TransactionCaptureRequestDraftSchemaV1.extend(
      optionalIdentity('transaction-capture-request-draft'),
    ),
  }).strict(),
  z.object({
    ...optionalIdentity('accounting-lead-request'),
    intent: z.literal('ingestion'),
    request: IngestionWorkRequestDraftSchemaV1.extend(
      optionalIdentity('ingestion-work-request-draft'),
    ),
  }).strict(),
  z.object({
    ...optionalIdentity('accounting-lead-request'),
    intent: z.literal('journal'),
    request: JournalWorkRequestDraftSchemaV1.extend(
      optionalIdentity('journal-work-request-draft'),
    ),
  }).strict(),
  z.object({
    ...optionalIdentity('accounting-lead-request'),
    intent: z.literal('chart_of_accounts'),
    request: ChartWorkRequestDraftSchemaV1.extend(
      optionalIdentity('chart-work-request-draft'),
    ),
  }).strict(),
  z.object({
    ...optionalIdentity('accounting-lead-request'),
    intent: z.literal('reconciliation'),
    request: ReconciliationWorkRequestDraftSchemaV1.extend(
      optionalIdentity('reconciliation-work-request-draft'),
    ),
  }).strict(),
]);

export const DelegateTeamToolInputSchema = z.object({
  team: TeamIdSchema.describe('Exact registered specialist team id.'),
  request: z.union([
    jsonObjectSchema,
    z.string().min(2).max(32_000).describe('JSON-object text for providers that serialize nested tool input.'),
  ]).describe(
    'One semantic team request. Budgeting exact shape: '
      + '{"intent":"budget_plan","request":{"instruction":"preserve the user request","scopeKey":"monthly"}} '
      + 'or use intent "budget_scenarios" with request fields instruction and scenarioCount.',
  ),
}).strict().describe('Delegate exactly one user task to the specialist team matching the user intent.');

export type { TransactionCaptureRequestDraftV1 };

export function parseDelegateTeamToolInput(input: unknown) {
  const parsed = DelegateTeamToolInputSchema.parse(input);
  const request = decodeProviderRequest(parsed.request);
  if (parsed.team === 'query') {
    const canonical = QueryDelegateRequestSchemaV1.safeParse(request);
    return {
      team: parsed.team,
      request: canonical.success
        ? canonical.data
        : QueryLeadRequestDraftSchemaV1.parse({
            ...request,
            schemaName: 'query-lead-request-draft',
            schemaVersion: 1,
          }),
    };
  }
  if (parsed.team === 'budgeting') {
    const canonical = BudgetingDelegateRequestSchemaV1.safeParse(request);
    if (canonical.success) return { team: parsed.team, request: canonical.data };
    const draft = BudgetingProviderRequestSchemaV1.parse(request);
    return {
      team: parsed.team,
      request: BudgetingDelegateRequestSchemaV1.parse({
        ...draft,
        schemaName: 'budgeting-lead-request',
        schemaVersion: 1,
        request: {
          ...draft.request,
          schemaName: draft.intent === 'budget_plan'
            ? 'budget-plan-request-draft'
            : 'budget-scenario-request-draft',
          schemaVersion: 1,
        },
      }),
    };
  }
  if (parsed.team === 'accounting') {
    const canonical = AccountingDelegateRequestSchemaV1.safeParse(request);
    if (canonical.success) return { team: parsed.team, request: canonical.data };
    const draft = AccountingProviderRequestSchemaV1.parse(request);
    const requestSchemaNames = {
      transaction_capture: 'transaction-capture-request-draft',
      ingestion: 'ingestion-work-request-draft',
      journal: 'journal-work-request-draft',
      chart_of_accounts: 'chart-work-request-draft',
      reconciliation: 'reconciliation-work-request-draft',
    } as const;
    return {
      team: parsed.team,
      request: AccountingDelegateRequestSchemaV1.parse({
        ...draft,
        schemaName: 'accounting-lead-request',
        schemaVersion: 1,
        request: {
          ...draft.request,
          schemaName: requestSchemaNames[draft.intent],
          schemaVersion: 1,
        },
      }),
    };
  }
  return { team: parsed.team, request };
}

function decodeProviderRequest(request: JsonValue | string): Record<string, JsonValue> {
  const decoded = typeof request === 'string' ? JSON.parse(request) as unknown : request;
  return jsonObjectSchema.parse(decoded);
}

export function requestForRuntime(request: unknown): JsonValue {
  return JSON.parse(JSON.stringify(request)) as JsonValue;
}

export function delegateTeamRequestCorrection(team: string): string {
  if (team === 'budgeting') {
    return 'Budgeting request must be exactly {"intent":"budget_plan","request":{"instruction":"preserve the user request","scopeKey":"monthly"}} or use intent "budget_scenarios" with request fields instruction and scenarioCount. The nested key is request.';
  }
  if (team === 'query') {
    return 'Query request must contain businessQuestion and may contain timeframe, desiredGrain, requiredCalculations, and coverage.';
  }
  if (team === 'accounting') {
    return 'Accounting intent must be transaction_capture, ingestion, journal, chart_of_accounts, or reconciliation, with the corresponding draft under the nested request key.';
  }
  return `Request must match the exact declared contract for team ${team}.`;
}
