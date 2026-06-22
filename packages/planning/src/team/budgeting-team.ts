import {
  PlusOneError,
  TeamLeadPlanSchemaV1,
  type TeamLeadPlanV1,
} from '@plus-one/contracts';
import type { TeamDefinition } from '@plus-one/runtime';
import {
  BudgetingLeadRequestSchemaV1,
  type BudgetingLeadRequestV1,
} from './contracts.js';
import { planningRoles } from './roles.js';
import { budgetingWorkCells } from './work-cells.js';

const budgetingLead = planningRoles.find((entry) => entry.identity.roleName === 'budgeting-lead');
if (budgetingLead === undefined) throw new Error('budgeting-lead role is missing');

export const budgetingTeamDefinition: TeamDefinition = {
  team: 'budgeting',
  lead: budgetingLead as TeamDefinition['lead'],
  charter: 'Turn checked household evidence into checked budget proposals and scenario comparisons.',
  prohibitedBehavior: [
    'Do not access database credentials, SQL, query tools, command handlers, or external financial systems.',
    'Do not persist a scenario comparison as a budget mutation.',
  ],
  workCells: budgetingWorkCells,
  allowedStrategyNames: ['single-maker-checker'],
};

const expectedCell = {
  budget_plan: 'budget-plan',
  budget_scenarios: 'budget-scenarios',
} as const;

export function validateBudgetingLeadPlan(request: BudgetingLeadRequestV1,
  candidate: unknown): TeamLeadPlanV1 {
  const input = BudgetingLeadRequestSchemaV1.parse(request);
  const plan = TeamLeadPlanSchemaV1.parse(candidate);
  if (plan.recommendedStrategyName !== 'single-maker-checker'
    || plan.work.length !== 1
    || plan.work[0]!.workCellId !== expectedCell[input.intent]) {
    throw new PlusOneError({
      category: 'policy_rejected',
      code: 'budgeting_lead_plan_invalid',
      message: 'Budgeting Lead must route one typed request to its matching work cell',
      retry: 'never',
      receiptLookupRequired: false,
      details: { intent: input.intent },
    });
  }
  return plan;
}
