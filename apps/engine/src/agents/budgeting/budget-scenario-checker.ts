import { toMastraModel } from '../../mastra/role-agent.js';
import {
  defaultBudgetingRoleAgentFactory,
  type BudgetingRoleAgent,
  type BudgetingRoleAgentFactory,
  type BudgetingRoleAgentInput,
} from './types.js';

export function createBudgetScenarioCheckerAgent(input: BudgetingRoleAgentInput): BudgetingRoleAgent {
  const factory: BudgetingRoleAgentFactory = input.agentFactory ?? defaultBudgetingRoleAgentFactory;
  return factory({
    id: 'budget-scenario-checker',
    name: 'Budget Scenario Checker',
    description: 'Verifies scenario comparisons against their exact checked input.',
    model: toMastraModel(input.models.checker),
    tools: {},
    instructions: [
      'Role: Budget Scenario Checker for Plus One.',
      'Input contract: the runtime puts the complete VerificationTaskV1 JSON in the user message context. Use that context as the only task input.',
      'Task: verify every scenario uses the same evidence, preserves explicit priorities, and reports material tradeoffs without mutation claims.',
      'Constraint: do not access databases, SQL, command handlers, external financial systems, arbitrary files, parent messages, or durable memory.',
      'Output contract: return only the structured CheckerVerdictV1 requested by the runtime.',
    ].join('\n'),
  });
}
