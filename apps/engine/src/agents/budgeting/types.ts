import { Agent } from '@mastra/core/agent';
import type { EngineLlmModelConfig, RoleAgentModel, RoleAgentTools } from '../../mastra/role-agent.js';

export interface BudgetingRoleAgentModels {
  lead: EngineLlmModelConfig;
  maker: EngineLlmModelConfig;
  checker: EngineLlmModelConfig;
}

export interface BudgetingRoleAgentInput {
  models: BudgetingRoleAgentModels;
  tools: RoleAgentTools;
  agentFactory?: BudgetingRoleAgentFactory;
}

export type BudgetingRoleAgent = Agent;

export type BudgetingRoleAgentFactory = (config: {
  id: string;
  name: string;
  description: string;
  model: RoleAgentModel;
  tools: RoleAgentTools;
  instructions: string;
}) => BudgetingRoleAgent;

export const defaultBudgetingRoleAgentFactory: BudgetingRoleAgentFactory = (config) =>
  new Agent(config);
