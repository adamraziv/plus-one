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

export const reportingSkills = [
  skill('investments-retirement-lead-routing', ['investments-retirement'], ['investments-retirement-lead'],
    'Route one typed informational request to one educational work cell.',
    ['Choose only investment-education or retirement-education under single-maker-checker.'],
    ['Reject extra work cells, mutation work, or personalized advice paths.']),
  skill('investment-education', ['investments-retirement'], ['investment-education-maker', 'investment-education-checker'],
    'Explain investment concepts and user-specified scenarios without recommending an action.',
    ['Use checked evidence, stay informational-only, and cite the evidence used.'],
    ['Reject personalized investment advice, missing citations, or missing disclaimer text.']),
  skill('retirement-education', ['investments-retirement'], ['retirement-education-maker', 'retirement-education-checker'],
    'Explain retirement concepts and user-specified scenarios without prescribing a strategy.',
    ['Use checked evidence, stay informational-only, and cite the evidence used.'],
    ['Reject personalized retirement strategy, missing citations, or missing disclaimer text.']),
  skill('records-reporting-lead-routing', ['records-reporting'], ['records-reporting-lead'],
    'Route one typed reporting request to records-facts or reporting-brief.',
    ['Choose only one work cell under single-maker-checker.'],
    ['Reject extra work cells or mutation-oriented routing.']),
  skill('records-facts', ['records-reporting'], ['records-maker', 'records-checker'],
    'Organize checked records into structured household facts and discrepancies.',
    ['Use only checked evidence and make discrepancies explicit.'],
    ['Reject summaries that hide missing evidence or unresolved discrepancies.']),
  skill('reporting-brief', ['records-reporting'], ['reporting-maker', 'reporting-checker'],
    'Turn checked records into a household brief that preserves freshness and uncertainty.',
    ['Preserve freshness, uncertainty, and policy labels from checked inputs.'],
    ['Reject unsupported claims, missing policy labels, or dropped uncertainty.']),
] as const;
