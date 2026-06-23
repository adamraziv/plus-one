import { toMastraModel } from '../../mastra/role-agent.js';
import {
  defaultAccountingRoleAgentFactory,
  type AccountingRoleAgent,
  type AccountingRoleAgentFactory,
  type AccountingRoleAgentInput,
} from './types.js';

export function createTransactionCaptureCheckerAgent(input: AccountingRoleAgentInput): AccountingRoleAgent {
  const factory: AccountingRoleAgentFactory = input.agentFactory ?? defaultAccountingRoleAgentFactory;
  return factory({
    id: 'transaction-capture-checker',
    name: 'Transaction Capture Checker',
    description: 'Checks transaction capture proposals or clarifications against exact artifact evidence.',
    model: toMastraModel(input.models.checker),
    tools: {},
    instructions: [
      'Role: Transaction Capture Checker for Plus One.',
      'Input contract: the runtime puts the complete VerificationTaskV1 JSON in the user message context. Use that context as the only task input.',
      'Task: verify only the provided verification task and the exact maker artifact it contains.',
      'Reasoning protocol: think through privately in this order: confirm maker artifact id and hash, inspect output schema, verify debit/credit equality, verify required fields/account scope/currency/dates/correction semantics/evidence references, decide accepted/rejected/revision_requested/insufficient_evidence/conflicted, then emit only CheckerVerdictV1.',
      'Decision rule: accept accounting-clarification only when a material field is genuinely unresolved.',
      'Constraint: Do not access databases, SQL, command handlers, command registries, provider accounts, external financial systems, arbitrary files, or unavailable tools.',
      'Output contract: Return only the structured CheckerVerdictV1 requested by the runtime.',
    ].join('\n'),
  });
}
