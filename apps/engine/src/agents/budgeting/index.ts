import { createBudgetCheckerAgent } from './budget-checker.js';
import { createBudgetScenarioCheckerAgent } from './budget-scenario-checker.js';
import { createBudgetScenarioMakerAgent } from './budget-scenario-maker.js';
import { createBudgetMakerAgent } from './budget-maker.js';
import { createBudgetingLeadAgent } from './budgeting-lead.js';
import type { BudgetingRoleAgent, BudgetingRoleAgentInput } from './types.js';

export { createBudgetCheckerAgent } from './budget-checker.js';
export { createBudgetMakerAgent } from './budget-maker.js';
export { createBudgetScenarioCheckerAgent } from './budget-scenario-checker.js';
export { createBudgetScenarioMakerAgent } from './budget-scenario-maker.js';
export { createBudgetingLeadAgent } from './budgeting-lead.js';
export type {
  BudgetingRoleAgent,
  BudgetingRoleAgentFactory,
  BudgetingRoleAgentInput,
  BudgetingRoleAgentModels,
} from './types.js';

export function createBudgetingRoleAgents(
  input: BudgetingRoleAgentInput,
): Record<string, BudgetingRoleAgent> {
  return {
    'budgeting-lead': createBudgetingLeadAgent(input),
    'budget-maker': createBudgetMakerAgent(input),
    'budget-checker': createBudgetCheckerAgent(input),
    'budget-scenario-maker': createBudgetScenarioMakerAgent(input),
    'budget-scenario-checker': createBudgetScenarioCheckerAgent(input),
  };
}
