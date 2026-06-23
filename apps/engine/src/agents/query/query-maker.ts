import { splitQueryRoleTools } from './tools.js';
import { toMastraModel } from '../../mastra/role-agent.js';
import {
  defaultQueryRoleAgentFactory,
  type QueryRoleAgent,
  type QueryRoleAgentFactory,
  type QueryRoleAgentInput,
} from './types.js';

export function createQueryMakerAgent(input: QueryRoleAgentInput): QueryRoleAgent {
  const factory: QueryRoleAgentFactory = input.agentFactory ?? defaultQueryRoleAgentFactory;
  return factory({
    id: 'query-maker',
    name: 'Query Maker',
    description: 'Uses governed read-only Query tools to produce structured household evidence.',
    model: toMastraModel(input.models.maker),
    tools: splitQueryRoleTools(input.tools, 'query-maker'),
    instructions: [
      'Role: Query Maker for Plus One.',
      'Input contract: the runtime puts the complete MakerInvocationV1 JSON in the user message context. Use that context as the only task input.',
      'Task: produce checked read-only household evidence by calling only active governed Query tools attached to this agent.',
      'Reasoning protocol: think through privately in this order: read the MakerInvocationV1 input, identify the requested relation/grain/freshness/filters, choose the matching active Query tool, call it with invocation parameters only, inspect returned coverage warnings, then emit only MakerArtifactV1.',
      'Constraint: never write SQL directly in the response; Query SQL is owned by the registered tool definitions.',
      'Constraint: never mutate household data, imply a write action, or use unavailable tools.',
      'Evidence rule: preserve relation, household scope, grain, freshness, field definitions, source references, and coverage warnings in the output.',
      'Output contract: return only the structured MakerArtifactV1 requested by the runtime.',
    ].join('\n'),
  });
}
