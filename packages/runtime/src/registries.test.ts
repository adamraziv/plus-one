import { describe, expect, it } from 'vitest';
import {
  ExecutionStrategyRegistry,
  SkillRegistry,
  ToolPermissionRegistry,
  createSkillRegistration,
} from './index.js';

describe('execution registries', () => {
  it('detects skill content drift and resolves exact versions', () => {
    const skill = createSkillRegistration({
      skillName: 'verified-lookup', skillVersion: 1, content: 'Check primary evidence first.',
      allowedTeams: ['query'], allowedRoles: ['query-maker', 'query-checker'],
      makerInstructions: ['Return typed claims.'], checkerRubric: ['Verify every claim.'],
    });
    const registry = new SkillRegistry([skill]);
    expect(registry.resolve(skill.identity).content).toBe('Check primary evidence first.');
    expect(() => registry.register({ ...skill, content: 'Changed without a new version.' })).toThrow(/hash/);
  });

  it('denies unregistered tools and fixes the required strategy catalog', () => {
    const tools = new ToolPermissionRegistry([{
      team: 'query',
      roleName: 'query-maker',
      roleVersion: 1,
      toolIds: ['query_balance'],
    }]);
    expect(tools.resolve({ team: 'query', roleName: 'query-maker', roleVersion: 1 })).toEqual(['query_balance']);
    expect(() => tools.resolve({ team: 'query', roleName: 'query-checker', roleVersion: 1 })).toThrow(/permission/);

    const strategies = ExecutionStrategyRegistry.withRequiredStrategies();
    expect(strategies.list().map((strategy) => strategy.name)).toEqual([
      'adversarial-analysis-reconciliation',
      'parallel-independent-makers',
      'single-maker-checker',
      'verified-factual-lookup',
    ]);
    expect(strategies.resolve('parallel-independent-makers').parallel).toBe(true);
  });

  it('rejects provider-unsafe tool ids before they reach an LLM provider', () => {
    expect(() => new ToolPermissionRegistry([{
      team: 'query',
      roleName: 'query-maker',
      roleVersion: 1,
      toolIds: ['query.balance'],
    }])).toThrow(/Tool id must contain only letters/);
    expect(() => new ToolPermissionRegistry([{
      team: 'query',
      roleName: 'query-maker',
      roleVersion: 1,
      toolIds: [''],
    }])).toThrow(/Tool id must contain only letters/);
    expect(() => new ToolPermissionRegistry([{
      team: 'query',
      roleName: 'query-maker',
      roleVersion: 1,
      toolIds: ['a'.repeat(65)],
    }])).toThrow(/Tool id must contain only letters/);
  });
});
