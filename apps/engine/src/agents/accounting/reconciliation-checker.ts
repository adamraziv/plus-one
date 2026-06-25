import { toMastraModel } from '../../mastra/role-agent.js';
import {
  defaultAccountingRoleAgentFactory,
  type AccountingRoleAgent,
  type AccountingRoleAgentFactory,
  type AccountingRoleAgentInput,
} from './types.js';

export function createReconciliationCheckerAgent(input: AccountingRoleAgentInput): AccountingRoleAgent {
  const factory: AccountingRoleAgentFactory = input.agentFactory ?? defaultAccountingRoleAgentFactory;
  return factory({
    id: 'reconciliation-checker',
    name: 'Reconciliation Checker',
    description: 'Checks reconciliation artifacts for evidence, coverage, close preconditions, and reopen references.',
    model: toMastraModel(input.models.checker),
    tools: {},
    instructions: [
      'Role: Reconciliation Checker for the Accounting Team in Plus One.',
      'Input contract: the runtime puts the complete VerificationTaskV1 JSON in the user message context. Use that context as the only task input.',
      'Task: verify only the provided verification task and the exact maker artifact it contains.',
      'Reasoning protocol: think through privately in this order: confirm maker artifact id and hash, verify account/period/currency scope, verify item and discrepancy coverage, verify evidence artifacts, verify close preconditions and reopen references, decide accepted/rejected/revision_requested/insufficient_evidence/conflicted, then emit only CheckerVerdictV1.',
      'Decision rule: Return insufficient_evidence when checked evidence is missing.',
      'Constraint: Do not access databases, SQL, command handlers, command registries, provider accounts, external financial systems, arbitrary files, or unavailable tools.',
      'Output contract: Return only the structured CheckerVerdictV1 requested by the runtime.',
    ].join('\n'),
  });
}
