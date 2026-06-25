import type { RuntimePolicyV1 } from '@plus-one/contracts';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import {
  PostgresArtifactRepository, PostgresVerificationLedgerRepository,
} from '@plus-one/database';
import {
  AgentInvocationRunner, AgentRegistry, ArtifactStore, MastraStructuredAgentAdapter,
  RoleContextBuilder, RuntimePolicyRegistry, SkillRegistry, TeamExecutor,
  ToolPermissionRegistry, VerificationRuntime, createSkillRegistration,
} from '@plus-one/runtime';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;
afterEach(async () => { await context?.cleanup(); context = undefined; });

describe('Mastra team execution framework', () => {
  it('persists one checked task while the checker sees only its exact verification task', async () => {
    context = await createPostgresTestContext('mastra_team_execution');
    const pool = new Pool({ connectionString: context.roleUrls.operations });
    await pool.query("INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone) VALUES ($1, 'USD', 'UTC')",
      ['hh_01JNZQ4A9B8C7D6E5F4G3H2J1K']);

    const makerGenerate = vi.fn().mockResolvedValue({ object: {
      schemaName: 'maker-artifact', schemaVersion: 1,
      outputSchema: { schemaName: 'lookup-output', schemaVersion: 1 },
      output: { answer: '42' },
      claims: [{ claimId: 'answer', text: 'Six times seven is 42.', evidenceArtifactIds: [] }],
      assumptions: [], uncertainty: [],
    } });
    const checkerGenerate = vi.fn(async (messages: readonly { role: string; content: string }[]) => {
      expect(messages).toHaveLength(1);
      const task = JSON.parse(messages[0]!.content);
      expect(Object.keys(task).sort()).toEqual([
        'checkerRole', 'householdId', 'makerArtifact', 'makerInput', 'permittedEvidence', 'policyLabels',
        'requiredOutputSchema', 'rubric', 'schemaName', 'schemaVersion', 'selectedSkill', 'taskId',
      ]);
      expect(task.parentMessages).toBeUndefined();
      expect(task.memory).toBeUndefined();
      expect(task.toolHistory).toBeUndefined();
      return { object: { verdict: 'accepted',
        coveredArtifactId: task.makerArtifact.artifactId,
        coveredArtifactHash: task.makerArtifact.artifactHash, findings: [] } };
    });

    const agents = new AgentRegistry();
    agents.register({ agentId: 'query-maker', modelId: 'provider/model-a',
      roleKind: 'maker', memoryEnabled: false, agent: { generate: makerGenerate } as never });
    agents.register({ agentId: 'query-checker', modelId: 'provider/model-a',
      roleKind: 'checker', memoryEnabled: false, agent: { generate: checkerGenerate } as never });
    const policy: Omit<RuntimePolicyV1, 'identity'> = {
      requiredCapabilities: ['structured_output'],
      primaryModel: 'provider/model-a', fallbackModels: [], maxModelSteps: 4,
      maxToolConcurrency: 1, maxAttempts: 2, maxModelRequestRetries: 0,
      maxProcessorRetries: 0, maxSandboxReproductions: 0,
      callDeadlineMs: 5_000, teamDeadlineMs: 20_000, endToEndDeadlineMs: 30_000,
      maxOutputBytes: 65_536,
    };
    const policies = new RuntimePolicyRegistry({
      models: { 'provider/model-a': ['structured_output'] },
      policies: [
        { ...policy, identity: { policyName: 'query-maker', policyVersion: 1 } },
        { ...policy, identity: { policyName: 'query-checker', policyVersion: 1 } },
      ],
    });
    const skill = createSkillRegistration({
      skillName: 'verified-lookup', skillVersion: 1, content: 'Return one exact checked answer.',
      allowedTeams: ['query'], allowedRoles: ['query-maker', 'query-checker'],
      makerInstructions: ['Return one claim.'], checkerRubric: ['Check exact support.'],
    });
    const ledger = new PostgresVerificationLedgerRepository(pool);
    const runtime = new VerificationRuntime({
      ledger, artifacts: new ArtifactStore(new PostgresArtifactRepository(pool)), policies,
    });
    const runIds = [
      'run_01JNZQ4A9B8C7D6E5F4G3H2J1K', 'run_01JNZQ4A9B8C7D6E5F4G3H2J2K',
    ];
    const artifactIds = [
      'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K', 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K',
    ];
    const runner = new AgentInvocationRunner({
      agents: new MastraStructuredAgentAdapter(agents), policies, ledger,
      ids: { nextRunId: () => runIds.shift()! },
    });
    const executor = new TeamExecutor({
      runtime, runner, policies,
      contexts: new RoleContextBuilder({
        skills: new SkillRegistry([skill]),
        tools: new ToolPermissionRegistry([
          { team: 'query', roleName: 'query-maker', roleVersion: 1, toolIds: [] },
          { team: 'query', roleName: 'query-checker', roleVersion: 1, toolIds: [] },
        ]),
      }),
      ids: { nextArtifactId: () => artifactIds.shift()! },
    });
    const result = await executor.executeWorkCell({
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K', team: 'query',
      workCell: {
        workCellId: 'lookup',
        maker: { identity: { roleName: 'query-maker', roleVersion: 1 }, kind: 'maker',
          agentId: 'query-maker', runtimePolicy: { policyName: 'query-maker', policyVersion: 1 } },
        checker: { identity: { roleName: 'query-checker', roleVersion: 1 }, kind: 'checker',
          agentId: 'query-checker', runtimePolicy: { policyName: 'query-checker', policyVersion: 1 } },
        makerInputSchema: z.object({ question: z.string() }),
        makerOutputSchema: z.object({ answer: z.string() }),
        inputSchemaIdentity: { schemaName: 'lookup-input', schemaVersion: 1 },
        outputSchemaIdentity: { schemaName: 'lookup-output', schemaVersion: 1 },
        checkerRubric: { rubricName: 'lookup-rubric', rubricVersion: 1,
          instructions: ['Check the exact answer.'] },
        allowedSkillNames: ['verified-lookup'],
        evaluateStopCondition: ({ maker }) => maker.claims.length === 1
          ? { status: 'verified', reason: 'One exact checked claim satisfies the stop condition.', outstanding: [] }
          : { status: 'partial', reason: 'The required checked claim is absent.',
              outstanding: ['Expected exactly one checked claim.'] },
      },
      selectedSkill: skill.identity, makerInput: { question: 'What is six times seven?' },
      permittedEvidence: [], policyLabels: [],
      stopCondition: { code: 'exact-answer', description: 'Return one checked exact answer.' },
      strategyName: 'verified-factual-lookup', abortSignal: new AbortController().signal,
    });

    expect(result.status).toBe('verified');
    expect(makerGenerate).toHaveBeenCalledTimes(1);
    expect(checkerGenerate).toHaveBeenCalledTimes(1);
    const task = await ledger.findTask(
      'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K', 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    );
    expect(task).toMatchObject({ status: 'verified',
      currentMakerArtifactId: result.makerArtifacts[0]?.artifactId });
    const runs = await pool.query(
      'SELECT role, runtime_policy_name, runtime_policy_version, status FROM operations.agent_runs ORDER BY id',
    );
    expect(runs.rows).toEqual([
      { role: 'query-maker', runtime_policy_name: 'query-maker', runtime_policy_version: 1, status: 'succeeded' },
      { role: 'query-checker', runtime_policy_name: 'query-checker', runtime_policy_version: 1, status: 'succeeded' },
    ]);
    await pool.end();
  });
});
