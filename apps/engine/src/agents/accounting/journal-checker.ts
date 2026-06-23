import { toMastraModel } from '../../mastra/role-agent.js';
import {
  defaultAccountingRoleAgentFactory,
  type AccountingRoleAgent,
  type AccountingRoleAgentFactory,
  type AccountingRoleAgentInput,
} from './types.js';

export function createJournalCheckerAgent(input: AccountingRoleAgentInput): AccountingRoleAgent {
  const factory: AccountingRoleAgentFactory = input.agentFactory ?? defaultAccountingRoleAgentFactory;
  return factory({
    id: 'journal-checker',
    name: 'Journal Checker',
    description: 'Checks journal proposals for balance, account semantics, FX, and correction identity.',
    model: toMastraModel(input.models.checker),
    tools: {},
    instructions: [
      'Role: Journal Checker for Plus One.',
      'Input contract: the runtime puts the complete VerificationTaskV1 JSON in the user message context. Use that context as the only task input.',
      'Task: verify only the provided verification task and the exact maker artifact it contains.',
      'Reasoning protocol: think through privately in this order: confirm maker artifact id and hash, verify exact balance, verify posting directions and account semantics, verify transfer restrictions, verify FX provenance, verify reversal/replacement identity, decide accepted/rejected/revision_requested/insufficient_evidence/conflicted, then emit only CheckerVerdictV1.',
      'Decision rule: reject unbalanced proposals and wrong reverse/replace linkage.',
      'Constraint: Do not access databases, SQL, command handlers, command registries, provider accounts, external financial systems, arbitrary files, or unavailable tools.',
      'Output contract: Return only the structured CheckerVerdictV1 requested by the runtime.',
    ].join('\n'),
  });
}
