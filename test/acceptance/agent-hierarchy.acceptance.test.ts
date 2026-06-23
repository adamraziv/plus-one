import { describe, expect, it, vi } from 'vitest';
import {
  CheckerVerdictSchemaV1,
  InboundChannelMessageSchemaV1,
  MakerArtifactSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  QueryResultSchemaV1,
  TeamLeadPlanSchemaV1,
  type ArtifactEnvelopeV1,
  type CheckerVerdictV1,
} from '@plus-one/contracts';
import { querySkills, queryTeamDefinition } from '@plus-one/query';
import {
  AgentInvocationRunner,
  ArtifactStore,
  ExecutionStrategyRegistry,
  TeamExecutionCoordinator,
  TeamExecutor,
  TeamLeadPlanner,
  TeamResultAssembler,
  VerificationRuntime,
  type ArtifactRepository,
  type VerificationLedgerPort,
  type VerificationTaskSnapshot,
} from '@plus-one/runtime';
import { createAgentSystem } from '../../apps/engine/src/agent-catalog.js';
import { OrchestratorAgent } from '../../apps/engine/src/agents/orchestrator.js';
import type { OrchestratorTeamRuntime } from '../../apps/engine/src/tools/delegate-team.js';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const taskId = 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const resultTaskId = 'task_01JNZQ4A9B8C7D6E5F4G3H2J2K';
const now = '2026-06-23T10:00:00.000Z';
const models = {
  orchestrator: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
  lead: { id: 'provider/lead', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
  maker: { id: 'provider/maker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
  checker: { id: 'provider/checker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
  research: { id: 'provider/research', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
};

class MemoryArtifacts implements ArtifactRepository {
  readonly records = new Map<string, ArtifactEnvelopeV1>();

  async insert(artifact: ArtifactEnvelopeV1): Promise<void> {
    this.records.set(artifact.artifactId, structuredClone(artifact));
  }

  async findById(id: ArtifactEnvelopeV1['artifactId']): Promise<ArtifactEnvelopeV1 | undefined> {
    return this.records.get(id);
  }
}

class MemoryLedger implements VerificationLedgerPort {
  private readonly tasks = new Map<string, VerificationTaskSnapshot>();
  private readonly verdicts = new Map<string, CheckerVerdictV1>();
  readonly createTask = vi.fn(async (input: Parameters<VerificationLedgerPort['createTask']>[0]) => {
    const task: VerificationTaskSnapshot = {
      ...input,
      status: 'created',
      resumable: true,
      updatedAt: now,
    };
    this.tasks.set(input.taskId, task);
    return task;
  });
  readonly selectExecutionContract = vi.fn(async () => undefined);
  readonly startRun = vi.fn(async () => undefined);
  readonly finishRun = vi.fn(async () => undefined);
  readonly startAttempt = vi.fn(async () => undefined);
  readonly finishAttempt = vi.fn(async () => undefined);

  async transition(input: Parameters<VerificationLedgerPort['transition']>[0]) {
    const task = this.tasks.get(input.taskId);
    if (task?.status !== input.expectedFrom) {
      throw Object.assign(new Error('stale'), { code: 'stale_task_state' });
    }
    const updated: VerificationTaskSnapshot = {
      ...task,
      status: input.to,
      failureCategory: input.failureCategory ?? task.failureCategory,
      resumable: input.resumable ?? task.resumable,
      updatedAt: now,
    };
    this.tasks.set(input.taskId, updated);
    return updated;
  }

  async linkMakerArtifact(input: Parameters<VerificationLedgerPort['linkMakerArtifact']>[0]) {
    const task = this.tasks.get(input.taskId)!;
    this.tasks.set(input.taskId, {
      ...task,
      currentMakerArtifactId: input.artifactId,
      currentMakerArtifactHash: input.artifactHash,
      updatedAt: now,
    });
  }

  async recordCheckerVerdict(input: Parameters<VerificationLedgerPort['recordCheckerVerdict']>[0]) {
    const task = this.tasks.get(input.taskId)!;
    this.verdicts.set(input.taskId, input.verdict);
    this.tasks.set(input.taskId, {
      ...task,
      currentCheckerArtifactId: input.checkerArtifactId,
      updatedAt: now,
    });
  }

  async findLatestVerdict(_householdId: string, task: string) {
    return this.verdicts.get(task);
  }

  async findTask(_householdId: string, task: string) {
    return this.tasks.get(task);
  }

  async listResumable() {
    return [...this.tasks.values()].filter((task) => task.resumable);
  }
}

describe('agent hierarchy acceptance', () => {
  it('runs inbound orchestrator delegation into checked Query maker/checker execution', async () => {
    const calls: string[] = [];
    const system = createAgentSystem({
      models,
      queryTools: {},
      agentFactory: ({ agentId }) => ({
        generate: vi.fn(async (messages: readonly { content: string }[]) => {
          calls.push(agentId);
          if (agentId === 'query-lead') {
            return { object: TeamLeadPlanSchemaV1.parse({
              schemaName: 'team-lead-plan',
              schemaVersion: 1,
              recommendedStrategyName: 'single-maker-checker',
              work: [{ workCellId: 'query-evidence', makerInput: queryResult([]) }],
              stopCondition: { code: 'query-answer', description: 'Return one checked query answer.' },
            }) };
          }
          if (agentId === 'query-maker') {
            return { object: MakerArtifactSchemaV1.parse({
              schemaName: 'maker-artifact',
              schemaVersion: 1,
              outputSchema: { schemaName: 'query-result', schemaVersion: 1 },
              output: queryResult([{ account_id: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K', name: 'Cash' }]),
              claims: [{
                claimId: 'accounts-listed',
                text: 'The checked evidence includes one account row.',
                evidenceArtifactIds: [],
              }],
              assumptions: [],
              uncertainty: [],
            }) };
          }
          const verificationTask = JSON.parse(messages[0]!.content) as {
            makerArtifact: { artifactId: string; artifactHash: string };
          };
          return { object: CheckerVerdictSchemaV1.parse({
            verdict: 'accepted',
            coveredArtifactId: verificationTask.makerArtifact.artifactId,
            coveredArtifactHash: verificationTask.makerArtifact.artifactHash,
            findings: [],
          }) };
        }),
      } as never),
    });
    const verificationLedger = new MemoryLedger();
    const runtime = new VerificationRuntime({
      ledger: verificationLedger,
      artifacts: new ArtifactStore(new MemoryArtifacts()),
      policies: system.policies,
    });
    const runner = new AgentInvocationRunner({
      agents: system.adapter,
      policies: system.policies,
      ledger: verificationLedger,
      ids: {
        nextRunId: (() => {
          const ids = [
            'run_01JNZQ4A9B8C7D6E5F4G3H2J1K',
            'run_01JNZQ4A9B8C7D6E5F4G3H2J2K',
            'run_01JNZQ4A9B8C7D6E5F4G3H2J3K',
          ];
          return () => ids.shift()!;
        })(),
      },
    });
    const planner = new TeamLeadPlanner({
      runner,
      contexts: system.contexts,
      strategies: ExecutionStrategyRegistry.withRequiredStrategies(),
    });
    const executor = new TeamExecutor({
      runtime,
      runner,
      contexts: system.contexts,
      policies: system.policies,
      ids: {
        nextArtifactId: (() => {
          const ids = [
            'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
            'artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          ];
          return () => ids.shift()!;
        })(),
      },
    });
    const coordinator = new TeamExecutionCoordinator({
      executor,
      strategies: ExecutionStrategyRegistry.withRequiredStrategies(),
      assembler: new TeamResultAssembler(),
    });
    const leadSkill = querySkills.find((skill) => skill.identity.skillName === 'query-lead-routing')!.identity;
    const evidenceSkill = querySkills.find((skill) => skill.identity.skillName === 'query-evidence')!.identity;
    const teamRuntime: OrchestratorTeamRuntime = {
      runTeamLead: vi.fn(async (input) => {
        const plan = await planner.plan({
          householdId,
          taskId,
          team: queryTeamDefinition,
          selectedSkill: leadSkill,
          request: input.request,
          policyLabels: ['personalized_finance'],
          abortSignal: input.signal,
        });
        const workCell = queryTeamDefinition.workCells.find((cell) => cell.workCellId === plan.work[0]!.workCellId)!;
        return coordinator.execute({
          team: queryTeamDefinition,
          strategyName: plan.recommendedStrategyName,
          selectedSkill: evidenceSkill,
          resultTaskId,
          work: [{
            householdId,
            taskId,
            team: 'query',
            workCell,
            selectedSkill: evidenceSkill,
            makerInput: plan.work[0]!.makerInput,
            permittedEvidence: [],
            policyLabels: ['personalized_finance'],
            stopCondition: plan.stopCondition,
            strategyName: plan.recommendedStrategyName,
            abortSignal: input.signal,
          }],
          stopCondition: plan.stopCondition,
        });
      }),
    };
    let orchestrator!: OrchestratorAgent;
    const generate = vi.fn(async (messages) => {
      expect(messages).toContain('List accounts.');
      const result = await orchestrator.agentTools.delegateTeam.execute({
        team: 'query',
        request: { businessQuestion: 'List accounts.' },
      });
      return { object: OrchestratorFinalResponseSchemaV1.parse({
        schemaName: 'orchestrator-final-response',
        schemaVersion: 1,
        responseId: 'response-2026-06-23-001',
        householdId,
        conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        body: result.claims[0]!.text
          + '\n\nPlus One is an AI assistant, not a licensed financial professional.',
        policyBoundary: 'personalized_finance',
        citations: [{ label: 'query:accounts-listed', artifactId: result.claims[0]!.checkedMakerArtifactIds[0] }],
        assumptions: [],
        freshness: result.freshness,
        disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
        unsupportedCapabilities: [],
        recommendationActions: [],
        delivery: { channel: 'telegram', destination: { chatId: 'telegram-chat-42' }, format: 'plain_text' },
        responseHash: 'c'.repeat(64),
        createdAt: now,
      }) };
    });
    orchestrator = new OrchestratorAgent({
      model: models.orchestrator,
      agentFactory: (config) => ({ ...config, generate }) as never,
      teams: [queryTeamDefinition],
      teamRuntime,
    });
    const response = await orchestrator.run({ message: InboundChannelMessageSchemaV1.parse({
      schemaName: 'inbound-channel-message',
      schemaVersion: 1,
      conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      householdId,
      channel: 'telegram',
      externalMessageId: 'telegram-message-1',
      receivedAt: now,
      speaker: { principalRef: 'telegram:user:1' },
      body: 'List accounts.',
      attachments: [],
      metadata: { destination: { chatId: 'telegram-chat-42' } },
    }) });

    expect(calls).toEqual(['query-lead', 'query-maker', 'query-checker']);
    expect(teamRuntime.runTeamLead).toHaveBeenCalledWith(expect.objectContaining({ team: queryTeamDefinition }));
    expect(response.body).toContain('The checked evidence includes one account row.');
    expect(response.delivery.destination).toEqual({ chatId: 'telegram-chat-42' });
    expect(verificationLedger.createTask).toHaveBeenCalled();
  });
});

function queryResult(rows: Record<string, unknown>[]) {
  return QueryResultSchemaV1.parse({
    schemaName: 'query-result',
    schemaVersion: 1,
    relationName: 'reporting.accounts',
    grain: ['household', 'account'],
    rows,
    fieldDefinitions: ['account_id', 'name'],
    sourceReferences: ['relation=reporting.accounts'],
    freshness: 'fresh',
    coverageWarnings: [],
  });
}
