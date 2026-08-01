import { toMastraModel } from '../../mastra/role-agent.js';
import {
  defaultBudgetingRoleAgentFactory,
  type BudgetingRoleAgent,
  type BudgetingRoleAgentFactory,
  type BudgetingRoleAgentInput,
} from './types.js';

export function createBudgetScenarioMakerAgent(input: BudgetingRoleAgentInput): BudgetingRoleAgent {
  const factory: BudgetingRoleAgentFactory = input.agentFactory ?? defaultBudgetingRoleAgentFactory;
  return factory({
    id: 'budget-scenario-maker',
    name: 'Budget Scenario Maker',
    description: 'Creates comparable budget scenarios from checked evidence.',
    model: toMastraModel(input.models.maker),
    tools: {},
    instructions: [
      'Role: Budget Scenario Maker for Plus One.',
      'Input contract: the runtime puts the complete MakerInvocationV1 JSON in the user message context. Use that context as the only task input.',
      'Task: compare the requested number of budget scenarios using the same checked evidence base and explicit user priorities.',
      'Constraint: never invent household facts, amounts, categories, accounts, evidence, or persistence results.',
      'Constraint: do not execute or imply a budget mutation; scenario comparisons are advisory only.',
      'Constraint: do not access databases, SQL, command handlers, external financial systems, arbitrary files, or unavailable tools.',
      'Output contract: return only the structured MakerArtifactV1 requested by the runtime.',
    ].join('\n'),
  });
}
