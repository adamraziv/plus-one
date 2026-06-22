import type { WorkCellDefinition } from '@plus-one/runtime';
import {
  BudgetPlanRequestSchemaV1,
  BudgetScenarioComparisonSchemaV1,
  BudgetScenarioRequestSchemaV1,
  BudgetingWorkResultSchemaV1,
  CashFlowAnalysisOutputSchemaV1,
  CashFlowAnalysisRequestSchemaV1,
  CashFlowWorkResultSchemaV1,
  PlanningClarificationSchemaV1,
} from './contracts.js';
import { planningRoles } from './roles.js';

const byName = (name: string) => {
  const role = planningRoles.find((entry) => entry.identity.roleName === name);
  if (role === undefined) throw new Error('Unknown planning role ' + name);
  return role;
};

const clarificationAware: WorkCellDefinition['evaluateStopCondition'] = ({ maker }) => {
  const clarification = PlanningClarificationSchemaV1.safeParse(maker.output);
  if (clarification.success) {
    return {
      status: 'insufficient_evidence',
      reason: clarification.data.reason,
      outstanding: [...clarification.data.questions],
    };
  }
  return {
    status: 'verified',
    reason: 'Checker accepted the exact checked output.',
    outstanding: [],
  };
};

export const budgetPlanWorkCell: WorkCellDefinition = {
  workCellId: 'budget-plan',
  maker: byName('budget-maker') as WorkCellDefinition['maker'],
  checker: byName('budget-checker') as WorkCellDefinition['checker'],
  makerInputSchema: BudgetPlanRequestSchemaV1,
  makerOutputSchema: BudgetingWorkResultSchemaV1,
  inputSchemaIdentity: { schemaName: 'budget-plan-request', schemaVersion: 1 },
  outputSchemaIdentity: { schemaName: 'activate-budget-proposal', schemaVersion: 1 },
  checkerRubric: {
    rubricName: 'budget-plan-rubric',
    rubricVersion: 1,
    instructions: [
      'Verify the budget proposal uses only checked evidence and explicit priorities.',
      'Verify allocations, mappings, and dates reconcile.',
      'Accept clarification only when a material planning field is unresolved.',
    ],
  },
  allowedSkillNames: ['budget-plan'],
  evaluateStopCondition: clarificationAware,
};

export const budgetScenarioWorkCell: WorkCellDefinition = {
  workCellId: 'budget-scenarios',
  maker: byName('budget-scenario-maker') as WorkCellDefinition['maker'],
  checker: byName('budget-scenario-checker') as WorkCellDefinition['checker'],
  makerInputSchema: BudgetScenarioRequestSchemaV1,
  makerOutputSchema: BudgetScenarioComparisonSchemaV1,
  inputSchemaIdentity: { schemaName: 'budget-scenario-request', schemaVersion: 1 },
  outputSchemaIdentity: { schemaName: 'budget-scenario-comparison', schemaVersion: 1 },
  checkerRubric: {
    rubricName: 'budget-scenarios-rubric',
    rubricVersion: 1,
    instructions: [
      'Verify every scenario uses the same checked evidence base.',
      'Verify differences and tradeoffs are explicit and comparable.',
      'Do not turn a scenario comparison into a persisted mutation.',
    ],
  },
  allowedSkillNames: ['budget-scenarios'],
  evaluateStopCondition: () => ({
    status: 'verified',
    reason: 'Checker accepted the scenario comparison.',
    outstanding: [],
  }),
};

export const cashFlowAnalysisWorkCell: WorkCellDefinition = {
  workCellId: 'cash-flow-analysis',
  maker: byName('cash-flow-maker') as WorkCellDefinition['maker'],
  checker: byName('cash-flow-checker') as WorkCellDefinition['checker'],
  makerInputSchema: CashFlowAnalysisRequestSchemaV1,
  makerOutputSchema: CashFlowAnalysisOutputSchemaV1,
  inputSchemaIdentity: { schemaName: 'cash-flow-analysis-request', schemaVersion: 1 },
  outputSchemaIdentity: { schemaName: 'cash-flow-analysis-output', schemaVersion: 1 },
  checkerRubric: {
    rubricName: 'cash-flow-analysis-rubric',
    rubricVersion: 1,
    instructions: [
      'Verify period alignment, timing risk, and advisory recommendations against checked evidence.',
      'Verify any calculations reference checked analyst output when material.',
      'Reject advice that introduces new unchecked household facts.',
    ],
  },
  allowedSkillNames: ['cash-flow-analysis'],
  evaluateStopCondition: () => ({
    status: 'verified',
    reason: 'Checker accepted the cash-flow analysis output.',
    outstanding: [],
  }),
};

const cashFlowMutationCell = (
  workCellId: 'cash-flow-obligation' | 'cash-flow-savings-goal' | 'cash-flow-debt-plan',
  outputSchemaIdentity: { schemaName: string; schemaVersion: number },
): WorkCellDefinition => ({
  workCellId,
  maker: byName('cash-flow-maker') as WorkCellDefinition['maker'],
  checker: byName('cash-flow-checker') as WorkCellDefinition['checker'],
  makerInputSchema: CashFlowAnalysisRequestSchemaV1,
  makerOutputSchema: CashFlowWorkResultSchemaV1,
  inputSchemaIdentity: { schemaName: 'cash-flow-analysis-request', schemaVersion: 1 },
  outputSchemaIdentity,
  checkerRubric: {
    rubricName: workCellId + '-rubric',
    rubricVersion: 1,
    instructions: [
      'Verify the proposal matches the checked evidence package and explicit user instruction.',
      'Verify account, category, amount, and date semantics exactly.',
      'Accept clarification only when a material planning field is unresolved.',
    ],
  },
  allowedSkillNames: ['cash-flow-planning'],
  evaluateStopCondition: clarificationAware,
});

export const cashFlowObligationWorkCell = cashFlowMutationCell(
  'cash-flow-obligation',
  { schemaName: 'update-obligation-proposal', schemaVersion: 1 },
);
export const cashFlowSavingsGoalWorkCell = cashFlowMutationCell(
  'cash-flow-savings-goal',
  { schemaName: 'upsert-savings-goal-proposal', schemaVersion: 1 },
);
export const cashFlowDebtPlanWorkCell = cashFlowMutationCell(
  'cash-flow-debt-plan',
  { schemaName: 'upsert-debt-plan-proposal', schemaVersion: 1 },
);

export const budgetingWorkCells = [
  budgetPlanWorkCell,
  budgetScenarioWorkCell,
] as const;

export const cashFlowWorkCells = [
  cashFlowAnalysisWorkCell,
  cashFlowObligationWorkCell,
  cashFlowSavingsGoalWorkCell,
  cashFlowDebtPlanWorkCell,
] as const;
