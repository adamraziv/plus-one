import { createSkillRegistration, type SkillRegistration } from '@plus-one/runtime';

const skill = (skillName: string, roles: string[], content: string,
  makerInstructions: string[], checkerRubric: string[]): SkillRegistration =>
  createSkillRegistration({
    skillName,
    skillVersion: 1,
    content,
    allowedTeams: ['accounting'],
    allowedRoles: roles,
    makerInstructions,
    checkerRubric,
  });

export const accountingSkills = [
  skill('accounting-lead-routing', ['accounting-lead'],
    'Route one typed accounting request to one registered work cell.',
    ['Choose only a listed cell and a single-maker-checker strategy.'],
    ['Reject unknown cells, extra work, or a stop condition unrelated to the request.'],
  ),
  skill('transaction-capture', ['transaction-capture-maker', 'transaction-capture-checker'],
    'Convert an explicit instruction into an exact balanced journal proposal or a clarification.',
    [
      'Never infer a material payment account, currency, amount, or date without reliable evidence.',
      'Use only supplied identifiers and explicitly permitted evidence artifacts.',
    ],
    [
      'Verify debit/credit equality, material fields, correction semantics, and exact evidence references.',
    ],
  ),
  skill('accounting-journal', ['journal-maker', 'journal-checker'],
    'Prepare ordinary, transfer, split, adjustment, correction, and realized-FX journal proposals.',
    [
      'Preserve exact currencies, dates, rates, source labels, account classes, and correction links.',
    ],
    [
      'Verify balancing, transfer class restrictions, FX provenance, and reversal/replacement identity.',
    ],
  ),
  skill('chart-of-accounts', ['chart-maker', 'chart-checker'],
    'Prepare one typed account, hierarchy, metadata, currency, archival, or source-mapping change.',
    [
      'Do not claim confirmation or authority; emit only the proposed chart mutation.',
    ],
    [
      'Verify household/book scope, accounting class, normal balance, hierarchy, currency, and mapping identity.',
    ],
  ),
] as const;
