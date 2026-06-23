import { Agent } from '@mastra/core/agent';
import type { EngineLlmModelConfig } from '../config.js';

export type { EngineLlmModelConfig } from '../config.js';
export type RoleAgentTools = NonNullable<ConstructorParameters<typeof Agent>[0]['tools']>;

export function createRoleAgent(input: {
  agentId: string;
  roleName: string;
  model: EngineLlmModelConfig;
  tools: RoleAgentTools;
}): Agent {
  return new Agent({
    id: input.agentId,
    name: input.roleName,
    model: input.model.id,
    tools: input.tools,
    instructions: [
      `You are ${input.roleName} in Plus One.`,
      'The application supplies the authoritative per-call instructions.',
      'Return only structured output requested by the active invocation.',
      'Do not rely on memory, parent messages, hidden reasoning, or unavailable tools.',
    ].join('\n'),
  });
}
