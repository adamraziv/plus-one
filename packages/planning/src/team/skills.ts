import {
  createSkillRegistration,
  type SkillRegistration,
} from '@plus-one/runtime';

const skill = (
  skillName: string,
  teams: string[],
  roles: string[],
  content: string,
  makerInstructions: string[],
  checkerRubric: string[],
): SkillRegistration => createSkillRegistration({
  skillName,
  skillVersion: 1,
  content,
  allowedTeams: teams,
  allowedRoles: roles,
  makerInstructions,
  checkerRubric,
});

export const planningSkills = [
  skill('budgeting-lead-routing', ['budgeting'], ['budgeting-lead'],
    'Route one typed budgeting request to one budgeting work cell.',
    ['Choose only budget-plan or budget-scenarios.'],
    ['Reject extra work cells or non-budgeting strategies.']),
  skill('budget-plan', ['budgeting'], ['budget-maker', 'budget-checker'],
    'Create or revise one budget proposal from checked evidence.',
    ['Use only checked Evidence Package facts and explicit user priorities.'],
    ['Verify allocations reconcile, constraints remain explicit, and no unchecked facts appear.']),
  skill('budget-scenarios', ['budgeting'], ['budget-scenario-maker', 'budget-scenario-checker'],
    'Compare two or three budget scenarios without executing one.',
    ['Keep scenarios comparable and grounded in the same checked evidence.'],
    ['Verify assumptions and reported differences are explicit.']),
  skill('cash-flow-lead-routing', ['cash-flow'], ['cash-flow-lead'],
    'Route one typed cash-flow request to analysis or one planning work cell.',
    ['Use repeated cash-flow-analysis work only for parallel compare mode.'],
    ['Reject unknown cells or mutation cells under parallel execution.']),
  skill('cash-flow-analysis', ['cash-flow'], ['cash-flow-maker', 'cash-flow-checker'],
    'Analyze timing, liquidity, and cash-flow pressure from checked evidence.',
    ['Reference only checked evidence and declared calculations.'],
    ['Verify period alignment, scenario assumptions, and advisory-policy fit.']),
  skill('cash-flow-planning', ['cash-flow'], ['cash-flow-maker', 'cash-flow-checker'],
    'Produce one typed obligation, savings-goal, or debt-plan proposal.',
    ['Emit one schema-valid planning proposal or a clarification, never execution metadata.'],
    ['Verify exact payload fields, evidence grounding, and ownership of the planning record.']),
] as const;
