import {
  PlusOneError,
  TeamLeadPlanSchemaV1,
  type TeamLeadPlanV1,
} from '@plus-one/contracts';
import type { TeamDefinition } from '@plus-one/runtime';
import {
  InvestmentsRetirementLeadRequestSchemaV1,
  type InvestmentsRetirementLeadRequestV1,
} from './contracts.js';
import { reportingRoles } from './roles.js';
import { investmentsRetirementWorkCells } from './work-cells.js';

const lead = reportingRoles.find((entry) => entry.identity.roleName === 'investments-retirement-lead');
if (lead === undefined) throw new Error('investments-retirement-lead role is missing');

export const investmentsRetirementTeamDefinition: TeamDefinition = {
  team: 'investments-retirement',
  lead: lead as TeamDefinition['lead'],
  charter: 'Turn checked evidence into informational-only investment and retirement explanations.',
  prohibitedBehavior: [
    'Do not access database credentials, SQL, financial query tools, or command handlers.',
    'Do not recommend specific investments, allocations, trades, or personalized retirement strategies.',
    'Do not improvise unsupported Tax or Insurance advice through this team.',
  ],
  workCells: investmentsRetirementWorkCells,
  allowedStrategyNames: ['single-maker-checker'],
};

const expectedCell = {
  investment_education: 'investment-education',
  retirement_education: 'retirement-education',
} as const;

export function validateInvestmentsRetirementLeadPlan(
  request: InvestmentsRetirementLeadRequestV1,
  candidate: unknown,
): TeamLeadPlanV1 {
  const input = InvestmentsRetirementLeadRequestSchemaV1.parse(request);
  const plan = TeamLeadPlanSchemaV1.parse(candidate);
  if (plan.recommendedStrategyName !== 'single-maker-checker'
    || plan.work.length !== 1
    || plan.work[0]!.workCellId !== expectedCell[input.intent]) {
    throw new PlusOneError({
      category: 'policy_rejected',
      code: 'investments_retirement_lead_plan_invalid',
      message: 'Investments/Retirement Lead must route one typed request to its matching work cell',
      retry: 'never',
      receiptLookupRequired: false,
      details: { intent: input.intent },
    });
  }
  return plan;
}
