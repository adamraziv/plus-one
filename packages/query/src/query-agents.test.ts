import { describe, expect, it, vi } from 'vitest';
import { AgentRegistry, RuntimePolicyRegistry, SkillRegistry } from '@plus-one/runtime';
import {
  createQueryRuntimePolicies,
  queryRoles,
  querySkills,
  registerQueryAgents,
} from './index.js';

describe('Query Team agent registrations', () => {
  it('registers immutable query skills for lead, query cell, and analyst cell roles', () => {
    const skills = new SkillRegistry(querySkills);

    for (const skill of querySkills) {
      expect(skills.resolve(skill.identity).identity.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(querySkills.map((skill) => skill.identity.skillName).sort()).toEqual([
      'query-analyst',
      'query-evidence',
      'query-lead-routing',
    ]);
    expect(skills.assertAllowed(querySkills[0]!.identity, 'query', 'query-lead').identity.skillName)
      .toBe('query-lead-routing');
  });

  it('creates runtime policies with tool calling only where Query roles need tools', () => {
    const policies = createQueryRuntimePolicies({
      leadModel: 'provider/lead',
      makerModel: 'provider/maker',
      checkerModel: 'provider/checker',
    });
    const registry = new RuntimePolicyRegistry({
      models: {
        'provider/lead': ['structured_output'],
        'provider/maker': ['structured_output', 'tool_calling'],
        'provider/checker': ['structured_output', 'tool_calling'],
      },
      policies,
    });

    expect(registry.resolve({ policyName: 'query-lead', policyVersion: 1 }).requiredCapabilities)
      .toEqual(['structured_output']);
    expect(registry.resolve({ policyName: 'query-maker', policyVersion: 1 }).requiredCapabilities)
      .toEqual(['structured_output', 'tool_calling']);
    expect(registry.resolve({ policyName: 'query-checker', policyVersion: 1 }).requiredCapabilities)
      .toEqual(['structured_output']);
    expect(registry.resolve({ policyName: 'analyst-maker', policyVersion: 1 }).requiredCapabilities)
      .toEqual(['structured_output', 'tool_calling']);
    expect(registry.resolve({ policyName: 'analyst-checker', policyVersion: 1 }).requiredCapabilities)
      .toEqual(['structured_output', 'tool_calling']);
  });

  it('registers Query agents without checker memory', () => {
    const registry = new AgentRegistry();
    const agent = { generate: vi.fn() } as never;

    registerQueryAgents(registry, {
      models: { lead: 'provider/lead', maker: 'provider/maker', checker: 'provider/checker' },
      agents: Object.fromEntries(queryRoles.map((role) => [role.agentId, agent])),
    });

    for (const role of queryRoles) {
      const modelId = role.kind === 'lead' ? 'provider/lead'
        : role.kind === 'maker' ? 'provider/maker'
          : 'provider/checker';
      const registration = registry.resolve(role.agentId, modelId, role.kind);
      expect(registration.memoryEnabled).toBe(false);
    }
  });
});
