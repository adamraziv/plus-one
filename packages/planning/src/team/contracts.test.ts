import { describe, expect, it } from 'vitest';
import {
  BudgetPlanRequestSchemaV1,
  BudgetScenarioComparisonSchemaV1,
  BudgetingLeadRequestSchemaV1,
  CashFlowAnalysisOutputSchemaV1,
  CashFlowLeadRequestSchemaV1,
  PlanningClarificationSchemaV1,
} from './contracts.js';

const evidence = {
  schemaName: 'evidence-package',
  schemaVersion: 1,
  evidencePackageId: 'evidence_01JQ8000000000000000000012',
  householdId: 'hh_01JQ8000000000000000000012',
  request: {
    schemaName: 'evidence-request',
    schemaVersion: 1,
    householdId: 'hh_01JQ8000000000000000000012',
    requestId: 'evidence_01JQ8000000000000000000012',
    businessQuestion: 'Build next month budget',
    intendedUse: 'budgeting',
    timeframe: { start: '2026-07-01', end: '2026-07-31' },
    desiredGrain: ['month'],
    filters: [],
    requiredFreshness: 'projection freshness_at within 1 day',
    requiredCalculations: [],
    coverage: ['reporting.budget_variance'],
  },
  status: 'verified',
  requestInterpretation: 'Budget evidence.',
  dataScope: ['relation=reporting.budget_variance'],
  grain: ['month'],
  filters: [],
  queryResults: [{
    schemaName: 'query-result',
    schemaVersion: 1,
    relationName: 'reporting.budget_variance',
    grain: ['household', 'month', 'category'],
    rows: [{ category: 'groceries', planned_amount: '600.00', actual_amount: '660.00' }],
    fieldDefinitions: ['actual_amount', 'category', 'planned_amount'],
    sourceReferences: ['relation=reporting.budget_variance'],
    freshness: 'projection freshness_at within 1 day',
    coverageWarnings: [],
  }],
  assumptions: [],
  uncertainty: [],
  queryMakerArtifactId: 'artifact_01JQ8000000000000000000012',
  queryCheckerArtifactId: 'artifact_01JQ8000000000000000000013',
  queryCheckerOutput: {
    schemaName: 'query-checker-output',
    schemaVersion: 1,
    accepted: true,
    checkedQueryResultArtifactId: 'artifact_01JQ8000000000000000000012',
    findings: [],
  },
  stopCondition: 'verified',
  completionReason: 'ok',
} as const;

describe('planning team workflow contracts', () => {
  it('keeps budgeting routing typed', () => {
    expect(BudgetingLeadRequestSchemaV1.parse({
      schemaName: 'budgeting-lead-request',
      schemaVersion: 1,
      intent: 'budget_plan',
      request: { evidencePackage: evidence, instruction: 'Create July budget.' },
    }).intent).toBe('budget_plan');
  });

  it('requires a checked evidence package for budget plans', () => {
    expect(BudgetPlanRequestSchemaV1.parse({
      schemaName: 'budget-plan-request',
      schemaVersion: 1,
      householdId: evidence.householdId,
      evidencePackage: evidence,
      instruction: 'Revise grocery allocation.',
      scopeKey: 'monthly',
    }).scopeKey).toBe('monthly');
  });

  it('separates clarification from executable or advisory outputs', () => {
    expect(PlanningClarificationSchemaV1.parse({
      schemaName: 'planning-clarification',
      schemaVersion: 1,
      missingFields: ['priority'],
      questions: ['What should take priority if grocery and dining caps conflict?'],
      reason: 'Budget priorities are materially incomplete.',
    }).missingFields).toEqual(['priority']);
  });

  it('captures scenario comparisons without creating a mutation payload', () => {
    expect(BudgetScenarioComparisonSchemaV1.parse({
      schemaName: 'budget-scenario-comparison',
      schemaVersion: 1,
      householdId: evidence.householdId,
      scenarios: [
        { scenarioId: 'lean', summary: 'Cuts dining', tradeoffs: ['Less dining out'] },
        { scenarioId: 'buffered', summary: 'Adds emergency buffer', tradeoffs: ['Less discretionary spend'] },
      ],
      comparisons: ['buffered preserves more cash by month end'],
    }).scenarios).toHaveLength(2);
  });

  it('captures advisory cash-flow outputs separately from planning mutations', () => {
    expect(CashFlowLeadRequestSchemaV1.parse({
      schemaName: 'cash-flow-lead-request',
      schemaVersion: 1,
      intent: 'analysis',
      request: { evidencePackage: evidence, objective: 'Assess bill timing risk.', analysisMode: 'single' },
    }).intent).toBe('analysis');
    expect(CashFlowAnalysisOutputSchemaV1.parse({
      schemaName: 'cash-flow-analysis-output',
      schemaVersion: 1,
      householdId: evidence.householdId,
      summary: 'Cash gets tight before the second paycheck.',
      findings: ['Rent and loan payments cluster before 2026-07-15'],
      recommendations: ['Move one subscription renewal after payday'],
      calculationsUsed: [],
    }).recommendations).toHaveLength(1);
  });
});
