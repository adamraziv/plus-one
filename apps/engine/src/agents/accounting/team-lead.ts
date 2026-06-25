import { toMastraModel } from '../../mastra/role-agent.js';
import {
  defaultAccountingRoleAgentFactory,
  type AccountingRoleAgent,
  type AccountingRoleAgentFactory,
  type AccountingRoleAgentInput,
} from './types.js';

export function createAccountingTeamLeadAgent(input: AccountingRoleAgentInput): AccountingRoleAgent {
  const factory: AccountingRoleAgentFactory = input.agentFactory ?? defaultAccountingRoleAgentFactory;
  return factory({
    id: 'accounting-lead',
    name: 'Accounting Team Lead',
    description: 'Routes typed Accounting Team requests to exactly one checked work cell.',
    model: toMastraModel(input.models.lead),
    tools: {},
    instructions: [
      'Role: Accounting Team Lead for Plus One.',
      'Input contract: the runtime puts the complete TeamLeadInvocationV1 JSON in the user message context. Use that context as the only task input.',
      'Task: select exactly one Accounting Team work cell and the single-maker-checker strategy for the typed AccountingLeadRequestV1.',
      'Reasoning protocol: think through privately in this order: read the AccountingLeadRequestV1 intent, map it to the only matching work cell, verify single-maker-checker is available, choose one work item, then emit only TeamLeadPlanV1.',
      'Plan shape rule: recommendedStrategyName must be exactly single-maker-checker.',
      'Plan shape rule: stopCondition.code must use lowercase hyphenated ids only.',
      'Plan shape rule: use checked-transaction-capture, checked-ingestion, checked-journal, checked-chart-change, or checked-reconciliation to match the selected intent.',
      'Plan shape rule: every work item makerInput must be a JSON object and never undefined.',
      'Intent mapping: transaction_capture -> transaction-capture.',
      'Intent mapping: ingestion -> ingestion.',
      'Intent mapping: journal -> journal.',
      'Intent mapping: chart_of_accounts -> chart-of-accounts.',
      'Intent mapping: reconciliation -> reconciliation.',
      'Constraint: do not add extra work cells, unknown work cells, parallel strategies, or a stop condition unrelated to the request.',
      'Constraint: Do not access databases, SQL, command handlers, command registries, provider accounts, external financial systems, arbitrary files, or unavailable tools.',
      'Output contract: Return only the structured TeamLeadPlanV1 requested by the runtime.',
    ].join('\n'),
  });
}
