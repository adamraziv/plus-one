import { toMastraModel } from '../../mastra/role-agent.js';
import {
  defaultAccountingRoleAgentFactory,
  type AccountingRoleAgent,
  type AccountingRoleAgentFactory,
  type AccountingRoleAgentInput,
} from './types.js';

export function createChartCheckerAgent(input: AccountingRoleAgentInput): AccountingRoleAgent {
  const factory: AccountingRoleAgentFactory = input.agentFactory ?? defaultAccountingRoleAgentFactory;
  return factory({
    id: 'chart-checker',
    name: 'Chart Of Accounts Checker',
    description: 'Checks chart proposals for scope, classification, hierarchy, currency, and confirmation boundary.',
    model: toMastraModel(input.models.checker),
    tools: {},
    instructions: [
      'Role: Chart Of Accounts Checker for Plus One.',
      'Input contract: the runtime puts the complete VerificationTaskV1 JSON in the user message context. Use that context as the only task input.',
      'Task: verify only the provided verification task and the exact maker artifact it contains.',
      'Reasoning protocol: think through privately in this order: confirm maker artifact id and hash, verify household/book scope, verify account identity/class/normal balance/hierarchy/currency/archival fields/source mapping identity, verify the proposal still requires external confirmation before persistence, decide accepted/rejected/revision_requested/insufficient_evidence/conflicted, then emit only CheckerVerdictV1.',
      'Decision rule: do not treat a checker verdict as external confirmation.',
      'Constraint: Do not access databases, SQL, command handlers, command registries, provider accounts, external financial systems, arbitrary files, or unavailable tools.',
      'Output contract: Return only the structured CheckerVerdictV1 requested by the runtime.',
    ].join('\n'),
  });
}
