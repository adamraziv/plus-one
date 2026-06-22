import { describe, expect, it, vi } from 'vitest';
import {
  AgentRegistry,
  SkillRegistry,
  ToolPermissionRegistry,
} from '@plus-one/runtime';
import {
  budgetingTeamDefinition,
  cashFlowTeamDefinition,
  createPlanningRuntimePolicies,
  planningRoles,
  planningSkills,
  planningToolPermissions,
  registerPlanningAgents,
  validateBudgetingLeadPlan,
  validateCashFlowLeadPlan,
} from '../index.js';

describe('planning team registrations', () => {
  it('registers immutable skills and zero tools for every planning role', () => {
    const skills = new SkillRegistry(planningSkills);
    for (const skill of planningSkills) {
      expect(skills.resolve(skill.identity).identity.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
    const tools = new ToolPermissionRegistry(planningToolPermissions);
    for (const role of planningRoles) {
      expect(tools.resolve({
        team: role.agentId.startsWith('budget') ? 'budgeting' : 'cash-flow',
        roleName: role.identity.roleName,
        roleVersion: role.identity.roleVersion,
      })).toEqual([]);
    }
  });

  it('registers bounded agents without memory', () => {
    const registry = new AgentRegistry();
    const agent = { generate: vi.fn() } as never;
    registerPlanningAgents(registry, {
      models: { lead: 'provider/lead', maker: 'provider/maker', checker: 'provider/checker' },
      agents: Object.fromEntries(planningRoles.map((role) => [role.agentId, agent])),
    });
    for (const role of planningRoles) {
      expect(registry.resolve(
        role.agentId,
        role.kind === 'lead' ? 'provider/lead'
          : role.kind === 'maker' ? 'provider/maker' : 'provider/checker',
        role.kind,
      ).memoryEnabled).toBe(false);
    }
    expect(createPlanningRuntimePolicies({
      leadModel: 'provider/lead',
      makerModel: 'provider/maker',
      checkerModel: 'provider/checker',
    }).every((policy) => policy.maxToolConcurrency === 1 && policy.maxAttempts <= 2)).toBe(true);
  });

  it('exposes the budgeting and cash-flow work-cell catalogs', () => {
    expect(budgetingTeamDefinition.workCells.map((cell) => cell.workCellId)).toEqual([
      'budget-plan',
      'budget-scenarios',
    ]);
    expect(cashFlowTeamDefinition.workCells.map((cell) => cell.workCellId)).toEqual([
      'cash-flow-analysis',
      'cash-flow-obligation',
      'cash-flow-savings-goal',
      'cash-flow-debt-plan',
    ]);
  });

  it('routes budget intents to one allowed work cell', () => {
    expect(validateBudgetingLeadPlan({
      schemaName: 'budgeting-lead-request',
      schemaVersion: 1,
      intent: 'budget_plan',
      request: {},
    }, {
      schemaName: 'team-lead-plan',
      schemaVersion: 1,
      recommendedStrategyName: 'single-maker-checker',
      work: [{ workCellId: 'budget-plan', makerInput: {} }],
      stopCondition: { code: 'checked-budget-plan', description: 'Return one checked budget proposal.' },
    }).work[0]!.workCellId).toBe('budget-plan');
  });

  it('allows cash-flow analysis to use repeated parallel analysis cells only', () => {
    expect(validateCashFlowLeadPlan({
      schemaName: 'cash-flow-lead-request',
      schemaVersion: 1,
      intent: 'analysis',
      request: { analysisMode: 'parallel_compare' },
    }, {
      schemaName: 'team-lead-plan',
      schemaVersion: 1,
      recommendedStrategyName: 'parallel-independent-makers',
      work: [
        { workCellId: 'cash-flow-analysis', makerInput: {} },
        { workCellId: 'cash-flow-analysis', makerInput: {} },
      ],
      stopCondition: { code: 'checked-cash-flow-compare', description: 'Return two independently checked views.' },
    }).work).toHaveLength(2);
  });
});
