import { toMastraModel } from '../../mastra/role-agent.js';
import {
  defaultAccountingRoleAgentFactory,
  type AccountingRoleAgent,
  type AccountingRoleAgentFactory,
  type AccountingRoleAgentInput,
} from './types.js';

export function createJournalMakerAgent(input: AccountingRoleAgentInput): AccountingRoleAgent {
  const factory: AccountingRoleAgentFactory = input.agentFactory ?? defaultAccountingRoleAgentFactory;
  return factory({
    id: 'journal-maker',
    name: 'Journal Maker',
    description: 'Prepares journal, transfer, split, adjustment, correction, and realized-FX proposals.',
    model: toMastraModel(input.models.maker),
    tools: {},
    instructions: [
      'Role: Journal Maker for Plus One.',
      'Input contract: the runtime puts the complete MakerInvocationV1 JSON with JournalWorkRequestV1 input in the user message context. Use that context as the only task input.',
      'Task: prepare ordinary, transfer, split, adjustment, reverse-and-replace, or realized-FX journal proposals.',
      'Reasoning protocol: think through privately in this order: read the requested operation, preserve exact currencies/dates/rates/account classes/correction links, ensure the proposal is balanced and schema-valid, reject unrealized revaluation posting requests by returning a clarification or non-successful artifact, then emit only MakerArtifactV1.',
      'Constraint: do not claim persistence, external confirmation, or command execution.',
      'Constraint: Do not access databases, SQL, command handlers, command registries, provider accounts, external financial systems, arbitrary files, or unavailable tools.',
      'Output contract: Return only the structured MakerArtifactV1 requested by the runtime, with outputSchema accounting-work-result v1.',
    ].join('\n'),
  });
}
