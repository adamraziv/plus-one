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
  CashFlowLeadRequestSchemaV1,
} from '@plus-one/planning';
import {
  InvestmentsRetirementLeadRequestSchemaV1,
  RecordsReportingLeadRequestSchemaV1,
} from '@plus-one/reporting';
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

const ProviderTimeframeSchemaV1 = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

export const CashFlowRequestDraftSchemaV1 = z.object({
  objective: z.string().min(1).max(4_000),
  analysisMode: z.enum(['single', 'parallel_compare']).default('single'),
  timeframe: ProviderTimeframeSchemaV1.optional(),
}).strict();

export const EducationRequestDraftSchemaV1 = z.object({
  question: z.string().min(1).max(4_000),
}).strict();

export const RecordsFactRequestDraftSchemaV1 = z.object({
  focus: z.string().min(1).max(4_000),
}).strict();

export const ReportingBriefRequestDraftSchemaV1 = z.object({
  summaryGoal: z.string().min(1).max(4_000),
}).strict();

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

const CashFlowProviderRequestSchemaV1 = z.object({
  ...optionalIdentity('cash-flow-lead-request'),
  intent: z.enum(['analysis', 'obligation', 'savings_goal', 'debt_plan']),
  request: CashFlowRequestDraftSchemaV1,
}).strict();

const InvestmentsRetirementProviderRequestSchemaV1 = z.object({
  ...optionalIdentity('investments-retirement-lead-request'),
  intent: z.enum(['investment_education', 'retirement_education']),
  request: EducationRequestDraftSchemaV1,
}).strict();

const RecordsReportingProviderRequestSchemaV1 = z.discriminatedUnion('intent', [
  z.object({
    ...optionalIdentity('records-reporting-lead-request'),
    intent: z.literal('records_facts'),
    request: RecordsFactRequestDraftSchemaV1,
  }).strict(),
  z.object({
    ...optionalIdentity('records-reporting-lead-request'),
    intent: z.literal('reporting_brief'),
    request: ReportingBriefRequestDraftSchemaV1,
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
    const draft = AccountingProviderRequestSchemaV1.parse(
      normalizeAccountingProviderRequest(request),
    );
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
  if (parsed.team === 'cash-flow') {
    const draft = CashFlowProviderRequestSchemaV1.parse(request);
    return {
      team: parsed.team,
      request: CashFlowLeadRequestSchemaV1.parse({
        ...draft,
        schemaName: 'cash-flow-lead-request',
        schemaVersion: 1,
      }),
    };
  }
  if (parsed.team === 'investments-retirement') {
    const draft = InvestmentsRetirementProviderRequestSchemaV1.parse(request);
    return {
      team: parsed.team,
      request: InvestmentsRetirementLeadRequestSchemaV1.parse({
        ...draft,
        schemaName: 'investments-retirement-lead-request',
        schemaVersion: 1,
      }),
    };
  }
  if (parsed.team === 'records-reporting') {
    const draft = RecordsReportingProviderRequestSchemaV1.parse(request);
    return {
      team: parsed.team,
      request: RecordsReportingLeadRequestSchemaV1.parse({
        ...draft,
        schemaName: 'records-reporting-lead-request',
        schemaVersion: 1,
      }),
    };
  }
  return { team: parsed.team, request };
}

function decodeProviderRequest(request: JsonValue | string): Record<string, JsonValue> {
  const decoded = typeof request === 'string' ? JSON.parse(request) as unknown : request;
  return jsonObjectSchema.parse(decoded);
}

function normalizeAccountingProviderRequest(
  request: Record<string, JsonValue>,
): Record<string, JsonValue> {
  if (request.intent !== 'chart_of_accounts') return request;
  const nested = jsonRecord(request.request);
  if (nested === undefined) return request;
  const wrapped = jsonRecord(nested['chart-work-request-draft']);
  const draft = wrapped ?? nested;
  if (typeof draft.action !== 'string') return request;
  const suppliedKnown = jsonRecord(draft.known) ?? {};
  const known: Record<string, JsonValue> = {};
  copyProviderString(known, 'accountName', suppliedKnown.accountName ?? draft.accountName);
  copyProviderString(known, 'parentAccountName',
    suppliedKnown.parentAccountName ?? draft.parentAccountName);
  copyProviderString(known, 'purpose', suppliedKnown.purpose ?? draft.purpose);
  copyProviderString(known, 'accountingClass',
    suppliedKnown.accountingClass ?? suppliedKnown.accountType
      ?? draft.accountingClass ?? draft.accountType);
  copyProviderString(known, 'normalBalance',
    suppliedKnown.normalBalance ?? draft.normalBalance);
  copyProviderString(known, 'nativeCurrency',
    suppliedKnown.nativeCurrency ?? suppliedKnown.currency
      ?? draft.nativeCurrency ?? draft.currency);
  copyProviderString(known, 'ownershipLabel',
    suppliedKnown.ownershipLabel ?? draft.ownershipLabel);
  copyProviderString(known, 'sourceSystem',
    suppliedKnown.sourceSystem ?? draft.sourceSystem);
  copyProviderString(known, 'externalAccountId',
    suppliedKnown.externalAccountId ?? draft.externalAccountId);
  const accountName = typeof known.accountName === 'string' ? known.accountName : 'the requested account';
  const instruction = typeof draft.instruction === 'string' && draft.instruction.trim().length > 0
    ? draft.instruction
    : `Apply the requested chart-of-accounts change for ${accountName}.`;
  return {
    ...request,
    request: {
      action: draft.action,
      instruction,
      known,
    },
  };
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined;
}

function copyProviderString(
  target: Record<string, JsonValue>,
  key: string,
  value: JsonValue | undefined,
): void {
  if (typeof value === 'string' && value.trim().length > 0) target[key] = value;
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
    return 'For account creation use exactly {"intent":"chart_of_accounts","request":{"action":"create_account","instruction":"preserve the complete user request","known":{"accountName":"visible name","accountingClass":"asset","normalBalance":"debit","nativeCurrency":"USD","purpose":"visible purpose"}}}. Other accounting intents are transaction_capture, ingestion, journal, and reconciliation.';
  }
  if (team === 'cash-flow') {
    return 'Cash-flow intent must be analysis, obligation, savings_goal, or debt_plan. Use nested request {"objective":"preserve the user request","analysisMode":"single"} and optional timeframe with start and end dates.';
  }
  if (team === 'investments-retirement') {
    return 'Investments-retirement intent must be investment_education or retirement_education with nested request {"question":"preserve the user question"}.';
  }
  if (team === 'records-reporting') {
    return 'Records-reporting intent must be records_facts with nested request {"focus":"preserve the requested records scope"} or reporting_brief with nested request {"summaryGoal":"preserve the requested brief goal"}.';
  }
  return `Request must match the exact declared contract for team ${team}.`;
}
