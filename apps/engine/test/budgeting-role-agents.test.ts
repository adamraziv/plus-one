import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import {
  ArtifactEnvelopeSchemaV1,
  MakerArtifactSchemaV1,
  MakerInvocationSchemaV1,
  VerificationTaskSchemaV1,
} from '@plus-one/contracts';
import { planningSkills } from '@plus-one/planning';
import {
  createBudgetCheckerAgent,
  createBudgetMakerAgent,
  createBudgetingRoleAgents,
} from '../src/agents/budgeting/index.js';
import { captureContractSubmission } from '../../../test/helpers/contract-agent-test-double.js';

const models = {
  lead: { id: 'provider/lead', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
  maker: { id: 'provider/maker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
  checker: { id: 'provider/checker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
};

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const taskId = 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const intake = {
  schemaName: 'budgeting-intake-request' as const,
  schemaVersion: 1 as const,
  householdId,
  intent: 'budget_plan' as const,
  instruction: 'Create a monthly budget.',
  scopeKey: 'monthly',
  known: {},
};

function makerInvocation() {
  const skill = planningSkills.find((candidate) => candidate.identity.skillName === 'budgeting-intake')!;
  return MakerInvocationSchemaV1.parse({
    schemaName: 'maker-invocation',
    schemaVersion: 1,
    householdId,
    taskId,
    team: 'budgeting',
    role: { roleName: 'budget-maker', roleVersion: 1 },
    skill: skill.identity,
    inputSchema: { schemaName: 'budgeting-intake-request', schemaVersion: 1 },
    outputSchema: { schemaName: 'planning-clarification', schemaVersion: 1 },
    input: intake,
    permittedEvidence: [],
    policyLabels: ['personalized_finance'],
    stopCondition: { code: 'budgeting-intake', description: 'Return one checked clarification.' },
  });
}

function makerEnvelope() {
  return ArtifactEnvelopeSchemaV1.parse({
    artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    householdId,
    taskId,
    artifactType: 'maker_output',
    schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
    canonicalizationVersion: 'rfc8785-v1',
    hashAlgorithm: 'sha256',
    artifactHash: 'b'.repeat(64),
    payload: MakerArtifactSchemaV1.parse({
      schemaName: 'maker-artifact',
      schemaVersion: 1,
      outputSchema: { schemaName: 'planning-clarification', schemaVersion: 1 },
      output: {
        schemaName: 'planning-clarification',
        schemaVersion: 1,
        missingFields: ['priority', 'timeframe', 'target_amount', 'category_mapping'],
        questions: [
          'What should this budget prioritize?',
          'What timeframe should this budget cover?',
          'What total amount should this budget cover, and in which currency?',
          'Which budget categories should be included, and how should the amount be allocated across them?',
        ],
        reason: 'I need these budget details before I can prepare a checked plan.',
      },
      claims: [],
      assumptions: [],
      uncertainty: [],
    }),
    createdAt: '2026-06-24T00:00:00.000Z',
  });
}

describe('Budgeting Mastra role agents', () => {
  it('constructs all budgeting roles through the specialised factory', () => {
    const configs: Array<{ id?: string; instructions?: unknown }> = [];
    const agents = createBudgetingRoleAgents({
      models,
      tools: {},
      agentFactory: (config) => {
        configs.push(config as typeof configs[number]);
        return { generate: vi.fn() } as unknown as Agent;
      },
    });

    expect(Object.keys(agents).sort()).toEqual([
      'budget-checker',
      'budget-maker',
      'budget-scenario-checker',
      'budget-scenario-maker',
      'budgeting-lead',
    ]);
    expect(configs.every((config) => String(config.instructions).includes('Input contract:'))).toBe(true);
    expect(String(configs.find((config) => config.id === 'budget-maker')?.instructions))
      .toContain('planning clarification');
  });

  it('submits an intake clarification without calling the provider', async () => {
    const modelGenerate = vi.fn(async () => {
      throw new Error('model should not be called');
    });
    const agent = createBudgetMakerAgent({
      models,
      tools: {},
      agentFactory: () => ({ generate: modelGenerate } as unknown as Agent),
    });
    const submission = captureContractSubmission();
    await agent.generate(
      [{ role: 'user', content: JSON.stringify(makerInvocation()) }],
      submission.options as never,
    );

    expect(modelGenerate).not.toHaveBeenCalled();
    expect(submission.submitted()).toMatchObject({
      output: {
        schemaName: 'planning-clarification',
        missingFields: ['priority', 'timeframe', 'target_amount', 'category_mapping'],
      },
    });
  });

  it('accepts the deterministic intake clarification without calling the provider', async () => {
    const modelGenerate = vi.fn(async () => {
      throw new Error('model should not be called');
    });
    const agent = createBudgetCheckerAgent({
      models,
      tools: {},
      agentFactory: () => ({ generate: modelGenerate } as unknown as Agent),
    });
    const skill = planningSkills.find((candidate) => candidate.identity.skillName === 'budgeting-intake')!;
    const task = VerificationTaskSchemaV1.parse({
      schemaName: 'verification-task',
      schemaVersion: 1,
      householdId,
      taskId,
      checkerRole: { roleName: 'budget-checker', roleVersion: 1 },
      makerArtifact: makerEnvelope(),
      makerInput: intake,
      permittedEvidence: [],
      selectedSkill: skill.identity,
      rubric: { rubricName: 'budgeting-intake-rubric', rubricVersion: 1, instructions: ['Check.'] },
      policyLabels: ['personalized_finance'],
      requiredOutputSchema: { schemaName: 'checker-verdict', schemaVersion: 1 },
    });
    const submission = captureContractSubmission();
    await agent.generate(
      [{ role: 'user', content: JSON.stringify(task) }],
      submission.options as never,
    );

    expect(modelGenerate).not.toHaveBeenCalled();
    expect(submission.submitted()).toMatchObject({ verdict: 'accepted', findings: [] });
  });
});
