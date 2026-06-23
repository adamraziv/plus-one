import { Agent } from '@mastra/core/agent';
import type { EngineLlmModelConfig } from '../../config.js';
import type { RoleAgentTools } from '../../mastra/role-agent.js';

export type QueryRoleAgent = Agent;
export type QueryRoleAgentFactory = (
  config: ConstructorParameters<typeof Agent>[0],
) => QueryRoleAgent;

export interface QueryRoleAgentModels {
  lead: EngineLlmModelConfig;
  maker: EngineLlmModelConfig;
  checker: EngineLlmModelConfig;
}

export interface QueryRoleAgentInput {
  models: QueryRoleAgentModels;
  tools: RoleAgentTools;
  agentFactory?: QueryRoleAgentFactory;
}

export const defaultQueryRoleAgentFactory: QueryRoleAgentFactory = (config) => new Agent(config) as QueryRoleAgent;
