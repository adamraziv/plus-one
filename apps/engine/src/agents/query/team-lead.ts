import { splitQueryRoleTools } from './tools.js';
import { toMastraModel } from '../../mastra/role-agent.js';
import {
  defaultQueryRoleAgentFactory,
  type QueryRoleAgent,
  type QueryRoleAgentFactory,
  type QueryRoleAgentInput,
} from './types.js';

export function createQueryTeamLeadAgent(input: QueryRoleAgentInput): QueryRoleAgent {
  const factory: QueryRoleAgentFactory = input.agentFactory ?? defaultQueryRoleAgentFactory;
  return factory({
    id: 'query-lead',
    name: 'Query Team Lead',
    description: 'Plans checked Query Team work and selects the correct Query work cell.',
    model: toMastraModel(input.models.lead),
    tools: splitQueryRoleTools(input.tools, 'lead'),
    instructions: [
      'Role: Query Team Lead for Plus One.',
      'Input contract: the runtime puts the complete TeamLeadInvocationV1 JSON in the user message context. Use that context as the only task input.',
      'Task: select the correct Query work cell and execution strategy for the checked evidence request.',
      'Reasoning protocol: think through privately in this order: identify the requested evidence or calculation, match it to availableWorkCellIds, verify the recommendedStrategyName is allowed, choose the smallest work list that can satisfy the stopCondition, then emit only TeamLeadPlanV1.',
      'Routing rule: use query-evidence for governed financial reads.',
      'Routing rule: use query-analyst only when checked query data must be calculated in the sandbox.',
      'Constraint: do not answer household financial questions directly from memory, prior conversation, hidden state, or unavailable tools.',
      'Output contract: return only the structured TeamLeadPlanV1 requested by the runtime.',
    ].join('\n'),
  });
}
