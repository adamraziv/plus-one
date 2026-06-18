import {
  PlusOneError, TeamLeadPlanSchemaV1,
  type TeamLeadPlanV1,
} from '@plus-one/contracts';
import type { TeamDefinition } from '@plus-one/runtime';
import { AccountingLeadRequestSchemaV1, type AccountingLeadRequestV1 } from './contracts.js';
import { accountingRoles } from './roles.js';
import { accountingWorkCells } from './work-cells.js';

const lead = accountingRoles.find((entry) => entry.identity.roleName === 'accounting-lead');
if (lead === undefined) throw new Error('accounting-lead role is missing');

export const accountingTeamDefinition: TeamDefinition = {
  team: 'accounting',
  lead: lead as TeamDefinition['lead'],
  charter: 'Maintain checked internal household accounting records without external actions.',
  prohibitedBehavior: [
    'Do not execute SQL or access database credentials.',
    'Do not treat a checker verdict as external confirmation.',
    'Do not access databases, query tools, arbitrary files, command handlers, or external financial systems from agents.',
  ],
  workCells: accountingWorkCells,
  allowedStrategyNames: ['single-maker-checker'],
};

const expectedCell = {
  transaction_capture: 'transaction-capture',
  ingestion: 'ingestion',
  journal: 'journal',
  chart_of_accounts: 'chart-of-accounts',
  reconciliation: 'reconciliation',
} as const;

export function validateAccountingLeadPlan(request: AccountingLeadRequestV1,
  candidate: unknown): TeamLeadPlanV1 {
  const input = AccountingLeadRequestSchemaV1.parse(request);
  const plan = TeamLeadPlanSchemaV1.parse(candidate);
  if (plan.recommendedStrategyName !== 'single-maker-checker'
    || plan.work.length !== 1
    || plan.work[0]!.workCellId !== expectedCell[input.intent]) {
    throw new PlusOneError({
      category: 'policy_rejected',
      code: 'accounting_lead_plan_invalid',
      message: 'Accounting Lead must route one typed request to its matching work cell',
      retry: 'never',
      receiptLookupRequired: false,
      details: { intent: input.intent },
    });
  }
  return plan;
}
