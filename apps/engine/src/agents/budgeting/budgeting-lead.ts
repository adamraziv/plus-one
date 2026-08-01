import { toMastraModel } from '../../mastra/role-agent.js';
import {
  defaultBudgetingRoleAgentFactory,
  type BudgetingRoleAgent,
  type BudgetingRoleAgentFactory,
  type BudgetingRoleAgentInput,
} from './types.js';

export function createBudgetingLeadAgent(input: BudgetingRoleAgentInput): BudgetingRoleAgent {
  const factory: BudgetingRoleAgentFactory = input.agentFactory ?? defaultBudgetingRoleAgentFactory;
  return factory({
    id: 'budgeting-lead',
    name: 'Budgeting Team Lead',
    description: 'Routes one typed budgeting request to exactly one checked work cell.',
    model: toMastraModel(input.models.lead),
    tools: {},
    instructions: [
      'Role: Budgeting Team Lead for Plus One.',
      'Input contract: the runtime puts the complete TeamLeadInvocationV1 JSON in the user message context. Use that context as the only task input.',
      'Task: select exactly one budgeting work cell and the single-maker-checker strategy for the typed budgeting request.',
      'Reasoning protocol: read the request intent and nested schema, prefer the runtime suggested plan when it is present, map budget_plan to budgeting-intake or budget-plan and budget_scenarios to budgeting-intake or budget-scenarios, then emit only TeamLeadPlanV1.',
      'Plan shape rule: recommendedStrategyName must be exactly single-maker-checker.',
      'Plan shape rule: every work item makerInput must be the exact typed request object from the invocation and never undefined.',
      'Plan shape rule: use budgeting-intake for an intake request, checked-budget-plan for a complete budget plan, and checked-budget-scenarios for a complete scenario request.',
      'Constraint: do not invent missing budget facts, evidence, account identifiers, category identifiers, or household identifiers.',
      'Constraint: do not add extra work cells, unknown work cells, parallel strategies, or an unrelated stop condition.',
      'Constraint: do not access databases, SQL, command handlers, external financial systems, arbitrary files, or unavailable tools.',
      'Output contract: return only the structured TeamLeadPlanV1 requested by the runtime.',
    ].join('\n'),
  });
}
