import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { TeamLeadPlanSchemaV1, type RuntimePolicyV1 } from '@plus-one/contracts';
import {
  AgentInvocationRunner,
  RuntimePolicyRegistry,
  SkillRegistry,
  type StructuredAgentPort,
  ToolPermissionRegistry,
  createSkillRegistration,
} from '../index.js';
import { RoleContextBuilder } from '../context/role-context-builder.js';
import { ExecutionStrategyRegistry } from '../strategies/execution-strategy-registry.js';
import type { TeamDefinition, WorkCellDefinition } from '../teams/definitions.js';
import { TeamLeadPlanner } from './team-lead-planner.js';

const policy: RuntimePolicyV1 = {
  identity: { policyName: 'query-lead', policyVersion: 1 },
  requiredCapabilities: ['structured_output'],
  primaryModel: 'provider/lead',
  fallbackModels: [],
  maxModelSteps: 4,
  maxToolConcurrency: 1,
  maxAttempts: 1,
  maxModelRequestRetries: 0,
  maxProcessorRetries: 0,
  maxSandboxReproductions: 0,
  callDeadlineMs: 1_000,
  teamDeadlineMs: 2_000,
  endToEndDeadlineMs: 3_000,
  maxOutputBytes: 16_000,
};

const selectedSkill = createSkillRegistration({
  skillName: 'query-lead-routing',
  skillVersion: 1,
  content: 'Route one request to query-evidence.',
  allowedTeams: ['query'],
  allowedRoles: ['query-lead'],
  makerInstructions: [],
  checkerRubric: ['Verify routing.'],
}).identity;

const cell = {
  workCellId: 'query-evidence',
  maker: {
    identity: { roleName: 'query-maker', roleVersion: 1 },
    kind: 'maker',
    agentId: 'query-maker',
    runtimePolicy: { policyName: 'query-maker', policyVersion: 1 },
  },
  checker: {
    identity: { roleName: 'query-checker', roleVersion: 1 },
    kind: 'checker',
    agentId: 'query-checker',
    runtimePolicy: { policyName: 'query-checker', policyVersion: 1 },
  },
  makerInputSchema: z.object({}).strict(),
  makerOutputSchema: z.object({}).strict(),
  inputSchemaIdentity: { schemaName: 'query-result', schemaVersion: 1 },
  outputSchemaIdentity: { schemaName: 'query-result', schemaVersion: 1 },
  effectPolicy: { kind: 'none' },
  checkerRubric: {
    rubricName: 'query-rubric',
    rubricVersion: 1,
    instructions: ['Verify query output.'],
  },
  allowedSkillNames: ['query-evidence'],
  evaluateStopCondition: () => ({ status: 'verified', reason: 'accepted', outstanding: [] }),
} satisfies WorkCellDefinition;

const team = {
  team: 'query',
  lead: {
    identity: { roleName: 'query-lead', roleVersion: 1 },
    kind: 'lead',
    agentId: 'query-lead',
    runtimePolicy: { policyName: 'query-lead', policyVersion: 1 },
  },
  charter: 'Provide checked evidence.',
  prohibitedBehavior: ['Do not answer without checked evidence.'],
  workCells: [cell],
  allowedStrategyNames: ['single-maker-checker'],
} satisfies TeamDefinition;

describe('TeamLeadPlanner', () => {
  it('invokes a team lead through isolated context and validates the returned plan', async () => {
    const generate = vi.fn(async () => TeamLeadPlanSchemaV1.parse({
      schemaName: 'team-lead-plan',
      schemaVersion: 1,
      recommendedStrategyName: 'single-maker-checker',
      work: [{ workCellId: 'query-evidence', makerInput: {} }],
      stopCondition: { code: 'query-answer', description: 'Return one checked query answer.' },
    }));
    const runner = new AgentInvocationRunner({
      agents: { generate } as StructuredAgentPort,
      policies: new RuntimePolicyRegistry({
        models: { 'provider/lead': ['structured_output'] },
        policies: [policy],
      }),
      ledger: {
        startRun: vi.fn(async () => undefined),
        finishRun: vi.fn(async () => undefined),
        startAttempt: vi.fn(async () => undefined),
        finishAttempt: vi.fn(async () => undefined),
      },
      ids: { nextRunId: () => 'run_01JNZQ4A9B8C7D6E5F4G3H2J1K' },
    });
    const contexts = new RoleContextBuilder({
      skills: new SkillRegistry([{
        identity: selectedSkill,
        content: 'Route one request to query-evidence.',
        allowedTeams: ['query'],
        allowedRoles: ['query-lead'],
        makerInstructions: [],
        checkerRubric: ['Verify routing.'],
      }]),
      tools: new ToolPermissionRegistry([
        { team: 'query', roleName: 'query-lead', roleVersion: 1, toolIds: [] },
        { team: 'query', roleName: 'query-maker', roleVersion: 1, toolIds: ['query_account_list'] },
      ]),
    });
    const planner = new TeamLeadPlanner({
      runner,
      contexts,
      strategies: ExecutionStrategyRegistry.withRequiredStrategies(),
    });

    const plan = await planner.plan({
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      team,
      selectedSkill,
      request: { businessQuestion: 'What are our balances?' },
      policyLabels: ['personalized_finance'],
      abortSignal: AbortSignal.timeout(1_000),
    });

    expect(plan.work[0]?.workCellId).toBe('query-evidence');
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'query-lead',
      roleKind: 'lead',
      activeTools: [],
      parentMessages: [],
      memoryEnabled: false,
      outputSchema: expect.anything(),
    }));
  });

  it('normalizes underscore-delimited lead identifiers before validating the final plan', async () => {
    const generate = vi.fn(async () => ({
      schemaName: 'team-lead-plan',
      schemaVersion: 1,
      recommendedStrategyName: 'single_maker_checker',
      work: [{ workCellId: 'query_evidence', makerInput: {} }],
      stopCondition: { code: 'query_answer', description: 'Return one checked query answer.' },
    }));
    const runner = new AgentInvocationRunner({
      agents: { generate } as StructuredAgentPort,
      policies: new RuntimePolicyRegistry({
        models: { 'provider/lead': ['structured_output'] },
        policies: [policy],
      }),
      ledger: {
        startRun: vi.fn(async () => undefined),
        finishRun: vi.fn(async () => undefined),
        startAttempt: vi.fn(async () => undefined),
        finishAttempt: vi.fn(async () => undefined),
      },
      ids: { nextRunId: () => 'run_01JNZQ4A9B8C7D6E5F4G3H2J1K' },
    });
    const contexts = new RoleContextBuilder({
      skills: new SkillRegistry([{
        identity: selectedSkill,
        content: 'Route one request to query-evidence.',
        allowedTeams: ['query'],
        allowedRoles: ['query-lead'],
        makerInstructions: [],
        checkerRubric: ['Verify routing.'],
      }]),
      tools: new ToolPermissionRegistry([
        { team: 'query', roleName: 'query-lead', roleVersion: 1, toolIds: [] },
        { team: 'query', roleName: 'query-maker', roleVersion: 1, toolIds: ['query_account_list'] },
      ]),
    });
    const planner = new TeamLeadPlanner({
      runner,
      contexts,
      strategies: ExecutionStrategyRegistry.withRequiredStrategies(),
    });

    await expect(planner.plan({
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      team,
      selectedSkill,
      request: { businessQuestion: 'What are our balances?' },
      policyLabels: ['personalized_finance'],
      abortSignal: AbortSignal.timeout(1_000),
    })).resolves.toEqual({
      schemaName: 'team-lead-plan',
      schemaVersion: 1,
      recommendedStrategyName: 'single-maker-checker',
      work: [{ workCellId: 'query-evidence', makerInput: {} }],
      stopCondition: { code: 'query-answer', description: 'Return one checked query answer.' },
    });
  });
});
