import {
  PlusOneError,
  TeamLeadPlanSchemaV1,
  type TeamLeadPlanV1,
} from '@plus-one/contracts';
import type { TeamDefinition } from '@plus-one/runtime';
import {
  CashFlowLeadRequestSchemaV1,
  type CashFlowLeadRequestV1,
} from './contracts.js';
import { planningRoles } from './roles.js';
import { cashFlowWorkCells } from './work-cells.js';

const cashFlowLead = planningRoles.find((entry) => entry.identity.roleName === 'cash-flow-lead');
if (cashFlowLead === undefined) throw new Error('cash-flow-lead role is missing');

export const cashFlowTeamDefinition: TeamDefinition = {
  team: 'cash-flow',
  lead: cashFlowLead as TeamDefinition['lead'],
  charter: 'Turn checked household evidence into checked cash-flow advice and planning proposals.',
  prohibitedBehavior: [
    'Do not access database credentials, SQL, query tools, command handlers, or external financial systems.',
    'Do not execute planning mutations directly from agents.',
  ],
  workCells: cashFlowWorkCells,
  allowedStrategyNames: ['single-maker-checker', 'parallel-independent-makers'],
};

const expectedSingleCell = {
  analysis: 'cash-flow-analysis',
  obligation: 'cash-flow-obligation',
  savings_goal: 'cash-flow-savings-goal',
  debt_plan: 'cash-flow-debt-plan',
} as const;

export function validateCashFlowLeadPlan(request: CashFlowLeadRequestV1,
  candidate: unknown): TeamLeadPlanV1 {
  const input = CashFlowLeadRequestSchemaV1.parse(request);
  const plan = TeamLeadPlanSchemaV1.parse(candidate);
  const analysisMode = input.intent === 'analysis'
    && typeof input.request === 'object'
    && input.request !== null
    && 'analysisMode' in input.request
    ? (input.request as { analysisMode?: unknown }).analysisMode
    : undefined;
  if (analysisMode === 'parallel_compare') {
    const validParallel = plan.recommendedStrategyName === 'parallel-independent-makers'
      && plan.work.length >= 2
      && plan.work.every((item) => item.workCellId === 'cash-flow-analysis');
    if (!validParallel) {
      throw new PlusOneError({
        category: 'policy_rejected',
        code: 'cash_flow_lead_plan_invalid',
        message: 'Cash Flow Lead may use parallel execution only for repeated analysis cells',
        retry: 'never',
        receiptLookupRequired: false,
        details: { intent: input.intent },
      });
    }
    return plan;
  }
  if (plan.recommendedStrategyName !== 'single-maker-checker'
    || plan.work.length !== 1
    || plan.work[0]!.workCellId !== expectedSingleCell[input.intent]) {
    throw new PlusOneError({
      category: 'policy_rejected',
      code: 'cash_flow_lead_plan_invalid',
      message: 'Cash Flow Lead must route one typed request to its matching work cell',
      retry: 'never',
      receiptLookupRequired: false,
      details: { intent: input.intent },
    });
  }
  return plan;
}
