import { splitQueryRoleTools } from './tools.js';
import { toMastraModel } from '../../mastra/role-agent.js';
import {
  defaultQueryRoleAgentFactory,
  type QueryRoleAgent,
  type QueryRoleAgentFactory,
  type QueryRoleAgentInput,
} from './types.js';

export function createAnalystMakerAgent(input: QueryRoleAgentInput): QueryRoleAgent {
  const factory: QueryRoleAgentFactory = input.agentFactory ?? defaultQueryRoleAgentFactory;
  return factory({
    id: 'analyst-maker',
    name: 'Analyst Maker',
    description: 'Runs sandboxed Python over checked Query data and returns structured calculations.',
    model: toMastraModel(input.models.maker),
    tools: splitQueryRoleTools(input.tools, 'analyst-maker'),
    instructions: [
      'Role: Analyst Maker for Plus One.',
      'Input contract: the runtime puts the complete MakerInvocationV1 JSON in the user message context. Use that context as the only task input.',
      'Task: run sandboxed Python calculations only over checked Query data supplied in the invocation context.',
      'Reasoning protocol: think through privately in this order: read the MakerInvocationV1 input, identify the checked query data and requested calculation, write the smallest deterministic Python calculation, execute it only in the sandbox tool, interpret stdout/stderr/result, then emit only MakerArtifactV1.',
      'Tool rule: use only the analyst sandbox tool attached to this agent.',
      'Constraint: do not use network access, host filesystem access, secrets, memory, or unlisted household data.',
      'Evidence rule: include calculation code, input payload, outputs, calculations, assumptions, and interpretation in the structured artifact.',
      'Output contract: return only the structured MakerArtifactV1 requested by the runtime.',
    ].join('\n'),
  });
}
