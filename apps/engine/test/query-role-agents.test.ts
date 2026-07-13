import { describe, expect, it, vi } from 'vitest';
import { createSkillRegistration, RoleContextBuilder, SkillRegistry, ToolPermissionRegistry } from '@plus-one/runtime';
import type { Agent } from '@mastra/core/agent';
import {
  ArtifactEnvelopeSchemaV1,
  CheckerVerdictSchemaV1,
  MakerArtifactSchemaV1,
  MakerInvocationSchemaV1,
  QueryResultSchemaV1,
  VerificationTaskSchemaV1,
} from '@plus-one/contracts';
import { analystSandboxToolId } from '@plus-one/runtime';
import { createQueryRoleAgents, splitQueryRoleTools } from '../src/agents/query/index.js';
import { captureContractSubmission } from '../../../test/helpers/contract-agent-test-double.js';

const models = {
  lead: { id: 'provider/lead', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
  maker: { id: 'provider/maker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
  checker: { id: 'provider/checker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
};

const tools = {
  'query_account_list': { execute: vi.fn() },
  'query_current_balances': { execute: vi.fn() },
  'query_categorized_transactions': { execute: vi.fn() },
  'query_category_spend_monthly': { execute: vi.fn() },
  [analystSandboxToolId]: { execute: vi.fn() },
};

describe('Query Mastra role agents', () => {
  it('splits Query tools by role instead of giving every Query agent every tool', () => {
    expect(Object.keys(splitQueryRoleTools(tools, 'lead'))).toEqual([]);
    expect(Object.keys(splitQueryRoleTools(tools, 'query-maker')).sort()).toEqual([
      'query_account_list',
      'query_categorized_transactions',
      'query_category_spend_monthly',
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
      .toEqual(['query_account_list', 'query_categorized_transactions',
        'query_category_spend_monthly', 'query_current_balances']);
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
      relationName: 'reporting.current_balances',
      grain: ['household', 'account'],
      rows: [{ account_id: 'acc_1', native_amount: '10.00' }],
      fieldDefinitions: ['account_id', 'native_amount'],
      sourceReferences: ['relation=reporting.current_balances'],
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

    const submission = captureContractSubmission({
      activeTools: context.activeTools,
    });
    const result = await agents['query-maker']!.generate([...context.messages], submission.options as never);

    expect(tools.query_current_balances.execute).toHaveBeenCalledWith({
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    }, {});
    expect(submission.submitted()).toMatchObject({
      outputSchema: { schemaName: 'query-result', schemaVersion: 1 },
      claims: [{ claimId: 'query-result-summary' }],
    });
    expect(result).toMatchObject({
      text: '',
      toolResults: [{ payload: { toolName: 'query_current_balances' } }],
    });
  });

  it('routes explicit monthly category-spend coverage to the matching query tool', async () => {
    (tools.query_category_spend_monthly.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      schemaName: 'query-result',
      schemaVersion: 1,
      relationName: 'reporting.category_spend_monthly',
      grain: ['household', 'month', 'category'],
      rows: [],
      fieldDefinitions: ['month_start', 'category_name', 'native_amount', 'native_currency'],
      sourceReferences: ['relation=reporting.category_spend_monthly'],
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
        { team: 'query', roleName: 'query-maker', roleVersion: 1, toolIds: ['query_category_spend_monthly'] },
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
          businessQuestion: 'What are my top expenses this month?',
          intendedUse: 'expense_tracking',
          timeframe: { start: '2026-06-01', end: '2026-06-30' },
          desiredGrain: ['household', 'month', 'category'],
          filters: [],
          requiredFreshness: 'latest',
          requiredCalculations: [],
          coverage: ['category spend monthly'],
        },
        permittedEvidence: [],
        policyLabels: [],
        stopCondition: { code: 'query-answer', description: 'Return one checked query answer.' },
      }),
    });

    const submission = captureContractSubmission({
      activeTools: context.activeTools,
    });
    const result = await agents['query-maker']!.generate([...context.messages], submission.options as never);

    expect(tools.query_category_spend_monthly.execute).toHaveBeenCalledWith({
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    }, {});
    expect(submission.submitted()).toMatchObject({
      outputSchema: { schemaName: 'query-result', schemaVersion: 1 },
    });
    expect(result).toMatchObject({
      text: '',
      toolResults: [{ payload: { toolName: 'query_category_spend_monthly' } }],
    });
  });

  it('accepts a scoped QueryResultV1 when household is the only grain beyond the requested account grain', async () => {
    const skill = createSkillRegistration({
      skillName: 'query-evidence',
      skillVersion: 1,
      content: 'Use governed query tools.',
      allowedTeams: ['query'],
      allowedRoles: ['query-maker', 'query-checker'],
      makerInstructions: [],
      checkerRubric: ['Verify routing.'],
    });
    const queryResult = QueryResultSchemaV1.parse({
      schemaName: 'query-result',
      schemaVersion: 1,
      relationName: 'reporting.accounts',
      grain: ['household', 'account'],
      rows: [{ account_id: 'acc_1', name: 'Cash' }],
      fieldDefinitions: ['account_id', 'name'],
      sourceReferences: [
        'relation=reporting.accounts',
        'filter=household_id:eq:hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      ],
      freshness: 'latest available reporting projection',
      coverageWarnings: [],
    });
    const makerArtifact = ArtifactEnvelopeSchemaV1.parse({
      artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      artifactType: 'maker_output',
      schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
      canonicalizationVersion: 'rfc8785-v1',
      hashAlgorithm: 'sha256',
      artifactHash: 'a'.repeat(64),
      payload: MakerArtifactSchemaV1.parse({
        schemaName: 'maker-artifact',
        schemaVersion: 1,
        outputSchema: { schemaName: 'query-result', schemaVersion: 1 },
        output: queryResult,
        claims: [{ claimId: 'query-result-summary', text: 'Query returned one account.', evidenceArtifactIds: [] }],
        assumptions: [],
        uncertainty: [],
      }),
      createdAt: '2026-06-24T00:00:00.000Z',
    });
    const verificationTask = VerificationTaskSchemaV1.parse({
      schemaName: 'verification-task',
      schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      checkerRole: { roleName: 'query-checker', roleVersion: 1 },
      makerArtifact,
      makerInput: {
        schemaName: 'evidence-request',
        schemaVersion: 1,
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        requestId: 'evidence_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        businessQuestion: 'List our accounts.',
        intendedUse: 'household_finance_answer',
        timeframe: { start: '2026-06-24', end: '2026-06-24' },
        desiredGrain: ['account'],
        filters: [],
        requiredFreshness: 'latest available reporting projection',
        requiredCalculations: [],
        coverage: ['account list'],
      },
      permittedEvidence: [],
      selectedSkill: skill.identity,
      rubric: { rubricName: 'query-evidence', rubricVersion: 1, instructions: ['Verify routing.'] },
      policyLabels: [],
      requiredOutputSchema: { schemaName: 'checker-verdict', schemaVersion: 1 },
    });
    const context = new RoleContextBuilder({
      skills: new SkillRegistry([skill]),
      tools: new ToolPermissionRegistry([
        { team: 'query', roleName: 'query-checker', roleVersion: 1, toolIds: [] },
      ]),
    }).forChecker({
      team: 'query',
      role: { roleName: 'query-checker', roleVersion: 1 },
      selectedSkill: skill.identity,
      verificationTask,
    });
    const agents = createQueryRoleAgents({
      models,
      tools,
      agentFactory: (config) => ({
        ...config,
        generate: vi.fn(async () => {
          throw new Error('model should not be called');
        }),
      }) as never,
    });

    const submission = captureContractSubmission();
    const result = await agents['query-checker']!
      .generate([...context.messages], submission.options as never);

    expect(result).toEqual({ text: '', toolResults: [] });
    expect(CheckerVerdictSchemaV1.parse(submission.submitted())).toEqual({
      verdict: 'accepted',
      coveredArtifactId: makerArtifact.artifactId,
      coveredArtifactHash: makerArtifact.artifactHash,
      findings: [],
    });
  });
});
