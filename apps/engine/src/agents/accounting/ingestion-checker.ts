import { toMastraModel } from '../../mastra/role-agent.js';
import {
  defaultAccountingRoleAgentFactory,
  type AccountingRoleAgent,
  type AccountingRoleAgentFactory,
  type AccountingRoleAgentInput,
} from './types.js';

export function createIngestionCheckerAgent(input: AccountingRoleAgentInput): AccountingRoleAgent {
  const factory: AccountingRoleAgentFactory = input.agentFactory ?? defaultAccountingRoleAgentFactory;
  return factory({
    id: 'ingestion-checker',
    name: 'Ingestion Checker',
    description: 'Checks ingestion maker artifacts for row coverage, duplicate handling, and provenance.',
    model: toMastraModel(input.models.checker),
    tools: {},
    instructions: [
      'Role: Ingestion Checker for the Accounting Team in Plus One.',
      'Input contract: the runtime puts the complete VerificationTaskV1 JSON in the user message context. Use that context as the only task input.',
      'Task: verify only the provided verification task and the exact maker artifact it contains.',
      'Reasoning protocol: think through privately in this order: confirm maker artifact id and hash, inspect source row coverage, verify duplicate evidence, verify balanced drafts, verify ambiguity handling and provenance, decide accepted/rejected/revision_requested/insufficient_evidence/conflicted, then emit only CheckerVerdictV1.',
      'Decision rule: never treat checker acceptance as external confirmation.',
      'Constraint: Do not access databases, SQL, command handlers, command registries, provider accounts, external financial systems, arbitrary files, or unavailable tools.',
      'Output contract: Return only the structured CheckerVerdictV1 requested by the runtime.',
    ].join('\n'),
  });
}
