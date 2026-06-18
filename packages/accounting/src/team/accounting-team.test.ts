import { describe, expect, it, vi } from 'vitest';
import {
  AgentRegistry, SkillRegistry, ToolPermissionRegistry,
} from '@plus-one/runtime';
import {
  accountingRoles, accountingSkills, accountingToolPermissions,
  createAccountingRuntimePolicies, registerAccountingAgents,
} from '../index.js';

describe('Accounting Team registrations', () => {
  it('registers immutable skills and gives every accounting role zero tools', () => {
    const skills = new SkillRegistry(accountingSkills);
    for (const skill of accountingSkills) {
      expect(skills.resolve(skill.identity).identity.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
    const tools = new ToolPermissionRegistry(accountingToolPermissions);
    for (const role of accountingRoles) {
      expect(tools.resolve({
        team: 'accounting', roleName: role.identity.roleName, roleVersion: role.identity.roleVersion,
      })).toEqual([]);
    }
  });

  it('registers checkers without memory and bounded structured-output policies', () => {
    const registry = new AgentRegistry();
    const agent = { generate: vi.fn() } as never;
    registerAccountingAgents(registry, {
      models: { lead: 'provider/lead', maker: 'provider/maker', checker: 'provider/checker' },
      agents: Object.fromEntries(accountingRoles.map((role) => [role.agentId, agent])),
    });
    for (const role of accountingRoles) {
      const modelId = role.kind === 'lead' ? 'provider/lead'
        : role.kind === 'maker' ? 'provider/maker' : 'provider/checker';
      expect(registry.resolve(role.agentId, modelId, role.kind).memoryEnabled).toBe(false);
    }
    const policies = createAccountingRuntimePolicies({
      leadModel: 'provider/lead', makerModel: 'provider/maker', checkerModel: 'provider/checker',
    });
    expect(policies.every((policy) => policy.maxAttempts <= 2 && policy.maxToolConcurrency === 1))
      .toBe(true);
  });
});
