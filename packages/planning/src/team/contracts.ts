import { z } from 'zod';
import {
  ActivateBudgetProposalSchemaV1,
  EvidencePackageSchemaV1,
  HouseholdIdSchema,
  UpdateObligationProposalSchemaV1,
  UpsertDebtPlanProposalSchemaV1,
  UpsertSavingsGoalProposalSchemaV1,
} from '@plus-one/contracts';

const text = z.string().min(1).max(4_000);

export const PlanningClarificationSchemaV1 = z.object({
  schemaName: z.literal('planning-clarification'),
  schemaVersion: z.literal(1),
  missingFields: z.array(z.enum([
    'priority',
    'timeframe',
    'target_amount',
    'payment_timing',
    'account_selection',
    'category_mapping',
  ])).min(1),
  questions: z.array(text).min(1),
  reason: text,
}).strict();

export const BudgetPlanRequestSchemaV1 = z.object({
  schemaName: z.literal('budget-plan-request'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  evidencePackage: EvidencePackageSchemaV1,
  instruction: text,
  scopeKey: z.string().min(1).max(80),
}).strict();

export const BudgetPlanRequestDraftSchemaV1 = z.object({
  schemaName: z.literal('budget-plan-request-draft'),
  schemaVersion: z.literal(1),
  instruction: text,
  scopeKey: z.string().min(1).max(80).default('monthly'),
}).strict();

export const BudgetScenarioRequestSchemaV1 = z.object({
  schemaName: z.literal('budget-scenario-request'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  evidencePackage: EvidencePackageSchemaV1,
  instruction: text,
  scenarioCount: z.number().int().min(2).max(3),
}).strict();

export const BudgetScenarioRequestDraftSchemaV1 = z.object({
  schemaName: z.literal('budget-scenario-request-draft'),
  schemaVersion: z.literal(1),
  instruction: text,
  scenarioCount: z.number().int().min(2).max(3).default(2),
}).strict();

const BudgetPlanIntakeRequestSchemaV1 = z.object({
  schemaName: z.literal('budgeting-intake-request'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  intent: z.literal('budget_plan'),
  instruction: text,
  scopeKey: z.string().min(1).max(80),
}).strict();

const BudgetScenarioIntakeRequestSchemaV1 = z.object({
  schemaName: z.literal('budgeting-intake-request'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  intent: z.literal('budget_scenarios'),
  instruction: text,
  scenarioCount: z.number().int().min(2).max(3),
}).strict();

export const BudgetingIntakeRequestSchemaV1 = z.discriminatedUnion('intent', [
  BudgetPlanIntakeRequestSchemaV1,
  BudgetScenarioIntakeRequestSchemaV1,
]);

export const BudgetScenarioComparisonSchemaV1 = z.object({
  schemaName: z.literal('budget-scenario-comparison'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  scenarios: z.array(z.object({
    scenarioId: z.string().min(1).max(80),
    summary: text,
    tradeoffs: z.array(text),
  }).strict()).min(2).max(3),
  comparisons: z.array(text).min(1),
}).strict();

export const CashFlowAnalysisRequestSchemaV1 = z.object({
  schemaName: z.literal('cash-flow-analysis-request'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  evidencePackage: EvidencePackageSchemaV1,
  objective: text,
  analysisMode: z.enum(['single', 'parallel_compare']),
}).strict();

export const CashFlowAnalysisOutputSchemaV1 = z.object({
  schemaName: z.literal('cash-flow-analysis-output'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  summary: text,
  findings: z.array(text).min(1),
  recommendations: z.array(text),
  calculationsUsed: z.array(text),
}).strict();

export const BudgetingLeadRequestSchemaV1 = z.object({
  schemaName: z.literal('budgeting-lead-request'),
  schemaVersion: z.literal(1),
  intent: z.enum(['budget_plan', 'budget_scenarios']),
  request: z.json(),
}).strict();

export const BudgetingDelegateRequestSchemaV1 = z.discriminatedUnion('intent', [
  z.object({
    schemaName: z.literal('budgeting-lead-request'),
    schemaVersion: z.literal(1),
    intent: z.literal('budget_plan'),
    request: BudgetPlanRequestDraftSchemaV1,
  }).strict(),
  z.object({
    schemaName: z.literal('budgeting-lead-request'),
    schemaVersion: z.literal(1),
    intent: z.literal('budget_scenarios'),
    request: BudgetScenarioRequestDraftSchemaV1,
  }).strict(),
]);

export const MaterializedBudgetingLeadRequestSchemaV1 = z.discriminatedUnion('intent', [
  z.object({
    schemaName: z.literal('budgeting-lead-request'),
    schemaVersion: z.literal(1),
    intent: z.literal('budget_plan'),
    request: z.union([BudgetPlanRequestSchemaV1, BudgetPlanIntakeRequestSchemaV1]),
  }).strict(),
  z.object({
    schemaName: z.literal('budgeting-lead-request'),
    schemaVersion: z.literal(1),
    intent: z.literal('budget_scenarios'),
    request: z.union([BudgetScenarioRequestSchemaV1, BudgetScenarioIntakeRequestSchemaV1]),
  }).strict(),
]);

export const CashFlowLeadRequestSchemaV1 = z.object({
  schemaName: z.literal('cash-flow-lead-request'),
  schemaVersion: z.literal(1),
  intent: z.enum(['analysis', 'obligation', 'savings_goal', 'debt_plan']),
  request: z.json(),
}).strict();

export const BudgetingWorkResultSchemaV1 = z.discriminatedUnion('schemaName', [
  PlanningClarificationSchemaV1,
  ActivateBudgetProposalSchemaV1,
  BudgetScenarioComparisonSchemaV1,
]);

export const CashFlowPlanningProposalSchemaV1 = z.discriminatedUnion('schemaName', [
  UpdateObligationProposalSchemaV1,
  UpsertSavingsGoalProposalSchemaV1,
  UpsertDebtPlanProposalSchemaV1,
]);

export const CashFlowWorkResultSchemaV1 = z.discriminatedUnion('schemaName', [
  PlanningClarificationSchemaV1,
  CashFlowAnalysisOutputSchemaV1,
  CashFlowPlanningProposalSchemaV1,
]);

export type PlanningClarificationV1 = z.infer<typeof PlanningClarificationSchemaV1>;
export type BudgetPlanRequestV1 = z.infer<typeof BudgetPlanRequestSchemaV1>;
export type BudgetPlanRequestDraftV1 = z.infer<typeof BudgetPlanRequestDraftSchemaV1>;
export type BudgetScenarioRequestV1 = z.infer<typeof BudgetScenarioRequestSchemaV1>;
export type BudgetScenarioRequestDraftV1 = z.infer<typeof BudgetScenarioRequestDraftSchemaV1>;
export type BudgetingIntakeRequestV1 = z.infer<typeof BudgetingIntakeRequestSchemaV1>;
export type BudgetScenarioComparisonV1 = z.infer<typeof BudgetScenarioComparisonSchemaV1>;
export type CashFlowAnalysisRequestV1 = z.infer<typeof CashFlowAnalysisRequestSchemaV1>;
export type CashFlowAnalysisOutputV1 = z.infer<typeof CashFlowAnalysisOutputSchemaV1>;
export type BudgetingLeadRequestV1 = z.infer<typeof BudgetingLeadRequestSchemaV1>;
export type BudgetingDelegateRequestV1 = z.infer<typeof BudgetingDelegateRequestSchemaV1>;
export type MaterializedBudgetingLeadRequestV1 =
  z.infer<typeof MaterializedBudgetingLeadRequestSchemaV1>;
export type CashFlowLeadRequestV1 = z.infer<typeof CashFlowLeadRequestSchemaV1>;
export type BudgetingWorkResultV1 = z.infer<typeof BudgetingWorkResultSchemaV1>;
export type CashFlowPlanningProposalV1 = z.infer<typeof CashFlowPlanningProposalSchemaV1>;
export type CashFlowWorkResultV1 = z.infer<typeof CashFlowWorkResultSchemaV1>;
