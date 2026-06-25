import { describe, expect, it, vi } from 'vitest';
import { createSkillRegistration, RoleContextBuilder, SkillRegistry, ToolPermissionRegistry } from '@plus-one/runtime';
import type { Agent } from '@mastra/core/agent';
import { MakerInvocationSchemaV1 } from '@plus-one/contracts';
import { analystSandboxToolId } from '@plus-one/runtime';
import { createQueryRoleAgents, splitQueryRoleTools } from '../src/agents/query/index.js';

const models = {
  lead: { id: 'provider/lead', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
  maker: { id: 'provider/maker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
  checker: { id: 'provider/checker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
};

const tools = {
  'query_account_list': { execute: vi.fn() } as never,
  'query_current_balances': { execute: vi.fn() } as never,
  [analystSandboxToolId]: { execute: vi.fn() } as never,
};

describe('Query Mastra role agents', () => {
  it('splits Query tools by role instead of giving every Query agent every tool', () => {
    expect(Object.keys(splitQueryRoleTools(tools, 'lead'))).toEqual([]);
    expect(Object.keys(splitQueryRoleTools(tools, 'query-maker')).sort()).toEqual([
      'query_account_list',
      'query_current_balances',
    ]);
    expect(Object.keys(splitQueryRoleTools(tools, 'query-checker'))).toEqual([]);
    expect(Object.keys(splitQueryRoleTools(tools, 'analyst-maker'))).toEqual([analystSandboxToolId]);
    expect(Object.keys(splitQueryRoleTools(tools, 'analyst-checker'))).toEqual([analystSandboxToolId]);
  });

  it('creates one concrete Mastra agent per Query role with role-owned instructions', () => {
    const configs: Array<{
      id?: string;
      name?: string;
      description?: string;
      model?: unknown;
      tools?: Record<string, unknown>;
      instructions?: unknown;
    }> = [];
    const agents = createQueryRoleAgents({
      models,
      tools,
      agentFactory: (config) => {
        configs.push(config as typeof configs[number]);
        return { generate: vi.fn() } as unknown as Agent;
      },
    });

    expect(Object.keys(agents).sort()).toEqual([
      'analyst-checker',
      'analyst-maker',
      'query-checker',
      'query-lead',
      'query-maker',
    ]);
    expect(configs.map((config) => config.id).sort()).toEqual([
      'analyst-checker',
      'analyst-maker',
      'query-checker',
      'query-lead',
      'query-maker',
    ]);
    expect(configs.find((config) => config.id === 'query-lead')).toMatchObject({
      name: 'Query Team Lead',
      model: {
        id: 'provider/lead',
        url: 'https://llm.example.test/v1',
        apiKey: 'test-api-key',
      },
      tools: {},
    });
    const queryLeadInstructions = String(configs.find((config) => config.id === 'query-lead')?.instructions);
    expect(queryLeadInstructions).toContain('select the correct Query work cell');
    expect(queryLeadInstructions).toContain('single-maker-checker');
    expect(queryLeadInstructions).toContain('query-answer');
    expect(Object.keys(configs.find((config) => config.id === 'query-maker')?.tools ?? {}).sort())
      .toEqual(['query_account_list', 'query_current_balances']);
    const queryMakerInstructions = String(configs.find((config) => config.id === 'query-maker')?.instructions);
    expect(queryMakerInstructions).toContain('householdId');
    expect(queryMakerInstructions).toContain('balance snapshot');
    expect(queryMakerInstructions).toContain('query_current_balances');
    expect(queryMakerInstructions).toContain('evidenceArtifactIds must be empty when permittedEvidence is empty');
    expect(queryMakerInstructions).toContain('include at least one claim');
    const queryCheckerInstructions = String(configs.find((config) => config.id === 'query-checker')?.instructions);
    expect(queryCheckerInstructions).toContain('filter=household_id:eq:<id>');
    expect(queryCheckerInstructions).toContain('VerificationTaskV1.makerInput');
    expect(Object.keys(configs.find((config) => config.id === 'query-checker')?.tools ?? {}))
      .toEqual([]);
    expect(Object.keys(configs.find((config) => config.id === 'analyst-maker')?.tools ?? {}))
      .toEqual([analystSandboxToolId]);
    expect(Object.keys(configs.find((config) => config.id === 'analyst-checker')?.tools ?? {}))
      .toEqual([analystSandboxToolId]);
  });

  it('runs the known query-evidence slice deterministically through the matching query tool', async () => {
    (tools.query_current_balances.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      schemaName: 'query-result',
      schemaVersion: 1,
      relationName: 'reporting.account_current_balances',
      grain: ['household', 'account'],
      rows: [{ account_id: 'acc_1', native_amount: '10.00' }],
      fieldDefinitions: ['account_id', 'native_amount'],
      sourceReferences: ['relation=reporting.account_current_balances'],
      freshness: 'latest available reporting projection',
      coverageWarnings: [],
    });
    const agents = createQueryRoleAgents({ models, tools });
    const skill = createSkillRegistration({
      skillName: 'query-evidence',
      skillVersion: 1,
      content: 'Use governed query tools.',
      allowedTeams: ['query'],
      allowedRoles: ['query-maker', 'query-checker'],
      makerInstructions: [],
      checkerRubric: ['Verify routing.'],
    });
    const context = new RoleContextBuilder({
      skills: new SkillRegistry([skill]),
      tools: new ToolPermissionRegistry([
        { team: 'query', roleName: 'query-maker', roleVersion: 1, toolIds: ['query_current_balances'] },
      ]),
    }).forMaker({
      team: 'query',
      role: { roleName: 'query-maker', roleVersion: 1 },
      selectedSkill: skill.identity,
      invocation: MakerInvocationSchemaV1.parse({
        schemaName: 'maker-invocation',
        schemaVersion: 1,
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        team: 'query',
        role: { roleName: 'query-maker', roleVersion: 1 },
        skill: skill.identity,
        inputSchema: { schemaName: 'evidence-request', schemaVersion: 1 },
        outputSchema: { schemaName: 'query-result', schemaVersion: 1 },
        input: {
          schemaName: 'evidence-request',
          schemaVersion: 1,
          householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
          requestId: 'evidence_01JNZQ4A9B8C7D6E5F4G3H2J1K',
          businessQuestion: 'What are our balances?',
          intendedUse: 'household_finance_answer',
          timeframe: { start: '2026-06-24', end: '2026-06-24' },
          desiredGrain: ['household', 'account'],
          filters: [],
          requiredFreshness: 'latest available reporting projection',
          requiredCalculations: [],
          coverage: ['balance snapshot'],
        },
        permittedEvidence: [],
        policyLabels: [],
        stopCondition: { code: 'query-answer', description: 'Return one checked query answer.' },
      }),
    });

    const result = await agents['query-maker']!.generate(context.messages, {
      activeTools: context.activeTools,
    } as never);

    expect(tools.query_current_balances.execute).toHaveBeenCalledWith({
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    }, {});
    expect(result).toMatchObject({
      object: {
        outputSchema: { schemaName: 'query-result', schemaVersion: 1 },
        claims: [{
          claimId: 'query-result-summary',
        }],
      },
      toolResults: [{ payload: { toolName: 'query_current_balances' } }],
    });
  });
});
