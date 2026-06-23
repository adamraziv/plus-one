import { Agent, type ToolsInput } from '@mastra/core/agent';
import type { EngineLlmModelConfig } from '../../config.js';

export type QueryRoleAgent = Agent<string, ToolsInput, unknown>;
export type QueryRoleAgentFactory = (
  config: ConstructorParameters<typeof Agent<string, ToolsInput, unknown>>[0],
) => QueryRoleAgent;

export interface QueryRoleAgentModels {
  lead: EngineLlmModelConfig;
  maker: EngineLlmModelConfig;
  checker: EngineLlmModelConfig;
}

export interface QueryRoleAgentInput {
  models: QueryRoleAgentModels;
  tools: ToolsInput;
  agentFactory?: QueryRoleAgentFactory;
}

export const defaultQueryRoleAgentFactory: QueryRoleAgentFactory = (config) => new Agent(config);
