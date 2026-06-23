import { Agent } from '@mastra/core/agent';
import type { EngineLlmModelConfig } from '../config.js';

export type { EngineLlmModelConfig } from '../config.js';
export type RoleAgentTools = NonNullable<ConstructorParameters<typeof Agent>[0]['tools']>;
export type RoleAgentModel = ConstructorParameters<typeof Agent>[0]['model'];

export function toMastraModel(model: EngineLlmModelConfig): RoleAgentModel {
  return {
    id: normalizeModelId(model.id),
    url: model.endpoint,
    apiKey: model.apiKey,
  };
}

function normalizeModelId(id: string): `${string}/${string}` {
  return id.includes('/') ? id as `${string}/${string}` : `custom/${id}`;
}

export function createRoleAgent(input: {
  agentId: string;
  roleName: string;
  model: EngineLlmModelConfig;
  tools: RoleAgentTools;
}): Agent {
  return new Agent({
    id: input.agentId,
    name: input.roleName,
    model: toMastraModel(input.model),
    tools: input.tools,
    instructions: [
      `You are ${input.roleName} in Plus One.`,
      'The application supplies the authoritative per-call instructions.',
      'Return only structured output requested by the active invocation.',
      'Do not rely on memory, parent messages, hidden reasoning, or unavailable tools.',
    ].join('\n'),
  });
}
