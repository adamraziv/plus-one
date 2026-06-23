import { Agent } from '@mastra/core/agent';
import type { EngineLlmModelConfig, RoleAgentModel, RoleAgentTools } from '../../mastra/role-agent.js';

export interface AccountingRoleAgentModels {
  lead: EngineLlmModelConfig;
  maker: EngineLlmModelConfig;
  checker: EngineLlmModelConfig;
}

export interface AccountingRoleAgentInput {
  models: AccountingRoleAgentModels;
  tools: RoleAgentTools;
  agentFactory?: AccountingRoleAgentFactory;
}

export type AccountingRoleAgent = Agent;

export type AccountingRoleAgentFactory = (config: {
  id: string;
  name: string;
  description: string;
  model: RoleAgentModel;
  tools: RoleAgentTools;
  instructions: string;
}) => AccountingRoleAgent;

export const defaultAccountingRoleAgentFactory: AccountingRoleAgentFactory = (config) =>
  new Agent(config);
