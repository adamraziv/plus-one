import { createSkillRegistration } from '@plus-one/runtime';

export const ingestionSkills = [
  createSkillRegistration({
    skillName: 'accounting-ingestion',
    skillVersion: 1,
    content: 'Normalize supplied immutable source artifacts; classify exact and probable duplicates; propose row decisions only.',
    allowedTeams: ['accounting'],
    allowedRoles: ['ingestion-maker', 'ingestion-checker'],
    makerInstructions: ['Preserve source values, row identity, and source lineage.', 'Never execute mutations.'],
    checkerRubric: ['Verify row coverage, duplicate evidence, balanced drafts, and ambiguity handling.'],
  }),
  createSkillRegistration({
    skillName: 'accounting-ingestion-check',
    skillVersion: 1,
    content: 'Check exact ingestion maker artifacts for row coverage, provenance, duplicate handling, and draft balance.',
    allowedTeams: ['accounting'],
    allowedRoles: ['ingestion-checker'],
    makerInstructions: [],
    checkerRubric: ['Never treat checker acceptance as external confirmation.'],
  }),
  createSkillRegistration({
    skillName: 'accounting-reconciliation',
    skillVersion: 1,
    content: 'Compare checked ledger evidence with immutable statement snapshots without changing facts.',
    allowedTeams: ['accounting'],
    allowedRoles: ['reconciliation-maker', 'reconciliation-checker'],
    makerInstructions: ['Keep ledger and statement balances separate.', 'List unresolved discrepancies.'],
    checkerRubric: ['Verify account, period, currency, item, discrepancy, and artifact coverage.'],
  }),
  createSkillRegistration({
    skillName: 'accounting-reconciliation-check',
    skillVersion: 1,
    content: 'Check reconciliation maker artifacts, close evidence, reopen references, and immutable provenance.',
    allowedTeams: ['accounting'],
    allowedRoles: ['reconciliation-checker'],
    makerInstructions: [],
    checkerRubric: ['Verify exact maker artifact hash and period lifecycle preconditions.'],
  }),
] as const;
