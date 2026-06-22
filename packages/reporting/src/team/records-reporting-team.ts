import {
  PlusOneError,
  TeamLeadPlanSchemaV1,
  type TeamLeadPlanV1,
} from '@plus-one/contracts';
import type { TeamDefinition } from '@plus-one/runtime';
import {
  RecordsReportingLeadRequestSchemaV1,
  type RecordsReportingLeadRequestV1,
} from './contracts.js';
import { reportingRoles } from './roles.js';
import { recordsReportingWorkCells } from './work-cells.js';

const lead = reportingRoles.find((entry) => entry.identity.roleName === 'records-reporting-lead');
if (lead === undefined) throw new Error('records-reporting-lead role is missing');

export const recordsReportingTeamDefinition: TeamDefinition = {
  team: 'records-reporting',
  lead: lead as TeamDefinition['lead'],
  charter: 'Turn checked evidence into records facts and household reporting briefs.',
  prohibitedBehavior: [
    'Do not access database credentials, SQL, financial query tools, or command handlers.',
    'Do not execute or imply a database mutation from records or reporting outputs.',
    'Do not improvise unsupported Tax or Insurance advice through this team.',
  ],
  workCells: recordsReportingWorkCells,
  allowedStrategyNames: ['single-maker-checker'],
};

const expectedCell = {
  records_facts: 'records-facts',
  reporting_brief: 'reporting-brief',
} as const;

export function validateRecordsReportingLeadPlan(
  request: RecordsReportingLeadRequestV1,
  candidate: unknown,
): TeamLeadPlanV1 {
  const input = RecordsReportingLeadRequestSchemaV1.parse(request);
  const plan = TeamLeadPlanSchemaV1.parse(candidate);
  if (plan.recommendedStrategyName !== 'single-maker-checker'
    || plan.work.length !== 1
    || plan.work[0]!.workCellId !== expectedCell[input.intent]) {
    throw new PlusOneError({
      category: 'policy_rejected',
      code: 'records_reporting_lead_plan_invalid',
      message: 'Records/Reporting Lead must route one typed request to its matching work cell',
      retry: 'never',
      receiptLookupRequired: false,
      details: { intent: input.intent },
    });
  }
  return plan;
}
