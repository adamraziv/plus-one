import { describe, expect, it, vi } from 'vitest';
import {
  AccountingClarificationSchemaV1,
  AccountingWorkResultSchemaV1,
  ChartOfAccountsProposalSchemaV1,
  accountingSkills,
  accountingTeamDefinition,
} from '@plus-one/accounting';
import {
  ConfirmImportBatchProposalSchemaV1,
  IngestionClarificationSchemaV1,
  IngestionWorkResultSchemaV1,
  ReconciliationClarificationSchemaV1,
  ReconciliationProposalSchemaV1,
  ReconciliationWorkResultSchemaV1,
  ingestionSkills,
} from '@plus-one/ingestion';
import {
  CheckerVerdictSchemaV1,
  ArtifactEnvelopeSchemaV1,
  InboundChannelMessageSchemaV1,
  MakerArtifactSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  TeamLeadPlanSchemaV1,
  TeamResultEnvelopeSchemaV1,
  type ArtifactEnvelopeV1,
  type CheckerVerdictV1,
  type JsonValue,
  type MakerArtifactV1,
  type TeamResultEnvelopeV1,
} from '@plus-one/contracts';
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
  type SkillRegistration,
  type VerificationLedgerPort,
  type VerificationTaskSnapshot,
} from '@plus-one/runtime';
import { createAgentSystem } from '../../apps/engine/src/agent-catalog.js';
import { OrchestratorAgent } from '../../apps/engine/src/agents/orchestrator.js';
import type { OrchestratorTeamRuntime } from '../../apps/engine/src/tools/delegate-team.js';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const bookId = 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const taskId = 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const resultTaskId = 'task_01JNZQ4A9B8C7D6E5F4G3H2J2K';
const now = '2026-06-23T10:00:00.000Z';
const hash = 'a'.repeat(64);
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

  async findByTaskAndHash(input: {
    householdId: ArtifactEnvelopeV1['householdId'];
    taskId: ArtifactEnvelopeV1['taskId'];
    artifactHash: ArtifactEnvelopeV1['artifactHash'];
  }): Promise<ArtifactEnvelopeV1 | undefined> {
    return [...this.records.values()].find((artifact) =>
      artifact.householdId === input.householdId
      && artifact.taskId === input.taskId
      && artifact.artifactHash === input.artifactHash);
  }
}

class MemoryLedger implements VerificationLedgerPort {
  private readonly tasks = new Map<string, VerificationTaskSnapshot>();
  private readonly verdicts = new Map<string, CheckerVerdictV1>();
  readonly createTask = vi.fn(async (input: Parameters<VerificationLedgerPort['createTask']>[0]) => {
    const task: VerificationTaskSnapshot = { ...input, status: 'created', resumable: true, updatedAt: now };
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
    if (task?.status !== input.expectedFrom) throw Object.assign(new Error('stale'), { code: 'stale_task_state' });
    const updated: VerificationTaskSnapshot = {
      ...task,
      status: input.to,
      resumable: input.resumable ?? task.resumable,
      updatedAt: now,
      ...(input.failureCategory === undefined ? {} : { failureCategory: input.failureCategory }),
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
    this.tasks.set(input.taskId, { ...task, currentCheckerArtifactId: input.checkerArtifactId, updatedAt: now });
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

describe('accounting team acceptance', () => {
  it.each([
    ['transaction_capture', 'transaction-capture', 'transaction-capture-maker'],
    ['ingestion', 'ingestion', 'ingestion-maker'],
    ['journal', 'journal', 'journal-maker'],
    ['chart_of_accounts', 'chart-of-accounts', 'chart-maker'],
    ['reconciliation', 'reconciliation', 'reconciliation-maker'],
  ] as const)('runs orchestrator delegation through accounting %s maker/checker', async (intent, workCellId, makerId) => {
    const result = await runAccountingScenario({
      intent,
      workCellId,
      makerOutputs: [makerOutputFor(workCellId, 'accepted')],
      checkerVerdicts: ['accepted'],
    });

    expect(result.calls).toEqual(['accounting-lead', makerId, makerId.replace('-maker', '-checker')]);
    expect(result.response.body).toContain('Accounting team status: verified');
    expect(result.teamResult.status).toBe('verified');
    expect(result.teamResult.makerArtifacts).toHaveLength(1);
    expect(result.teamResult.checkerVerdicts).toHaveLength(1);
    if (workCellId === 'chart-of-accounts') {
      expect(result.response.body).toContain('external confirmation required');
    }
  });

  it('revises maker output when checker requests a revision before accepting', async () => {
    const result = await runAccountingScenario({
      intent: 'transaction_capture',
      workCellId: 'transaction-capture',
      makerOutputs: [
        makerOutputFor('transaction-capture', 'accepted'),
        makerOutputFor('transaction-capture', 'accepted', 'revised'),
      ],
      checkerVerdicts: ['revision_requested', 'accepted'],
    });

    expect(result.calls).toEqual([
      'accounting-lead',
      'transaction-capture-maker',
      'transaction-capture-checker',
      'transaction-capture-maker',
      'transaction-capture-checker',
    ]);
    expect(result.teamResult.status).toBe('verified');
    expect(result.teamResult.checkerVerdicts.map((verdict) => verdict.verdict))
      .toEqual(['revision_requested', 'accepted']);
    expect(result.teamResult.claims[0]!.text).toContain('revised');
  });

  it.each([
    ['rejected', 'failed'],
    ['insufficient_evidence', 'insufficient_evidence'],
    ['conflicted', 'conflicted'],
  ] as const)('surfaces terminal checker verdict %s as team status %s', async (verdict, status) => {
    const result = await runAccountingScenario({
      intent: 'journal',
      workCellId: 'journal',
      makerOutputs: [makerOutputFor('journal', 'accepted')],
      checkerVerdicts: [verdict],
    });

    expect(result.teamResult.status).toBe(status);
    expect(result.teamResult.claims).toEqual([]);
    expect(result.response.body).toContain('Accounting team status: ' + status);
  });

  it.each([
    ['transaction_capture', 'transaction-capture'],
    ['ingestion', 'ingestion'],
    ['reconciliation', 'reconciliation'],
  ] as const)('returns insufficient evidence when %s maker emits a clarification', async (intent, workCellId) => {
    const result = await runAccountingScenario({
      intent,
      workCellId,
      makerOutputs: [makerOutputFor(workCellId, 'clarification')],
      checkerVerdicts: ['accepted'],
    });

    expect(result.teamResult.status).toBe('insufficient_evidence');
    expect(result.teamResult.outstanding.length).toBeGreaterThan(0);
    expect(result.response.body).toContain('Accounting team status: insufficient_evidence');
  });
});

async function runAccountingScenario(input: {
  intent: 'transaction_capture' | 'ingestion' | 'journal' | 'chart_of_accounts' | 'reconciliation';
  workCellId: 'transaction-capture' | 'ingestion' | 'journal' | 'chart-of-accounts' | 'reconciliation';
  makerOutputs: MakerArtifactV1[];
  checkerVerdicts: CheckerVerdictV1['verdict'][];
}) {
  const calls: string[] = [];
  const makerOutputs = [...input.makerOutputs];
  const checkerVerdicts = [...input.checkerVerdicts];
  const fakeAgent = (agentId: string) => ({
    generate: vi.fn(async (messages: readonly { content: string }[]) => {
      calls.push(agentId);
      if (agentId === 'accounting-lead') {
        return { object: TeamLeadPlanSchemaV1.parse({
          schemaName: 'team-lead-plan',
          schemaVersion: 1,
          recommendedStrategyName: 'single-maker-checker',
          work: [{ workCellId: input.workCellId, makerInput: makerInputFor(input.workCellId) }],
          stopCondition: { code: 'accounting-result', description: 'Return one checked accounting result.' },
        }) };
      }
      if (agentId.endsWith('-maker')) return { object: makerOutputs.shift()! };
      const verificationTask = JSON.parse(messages[0]!.content) as {
        makerArtifact: { artifactId: string; artifactHash: string };
      };
      const verdict = checkerVerdicts.shift()!;
      return { object: CheckerVerdictSchemaV1.parse({
        verdict,
        coveredArtifactId: verificationTask.makerArtifact.artifactId,
        coveredArtifactHash: verificationTask.makerArtifact.artifactHash,
        findings: verdict === 'accepted' ? [] : [{ code: 'needs-attention', message: 'Checker did not accept.' }],
      }) };
    }),
  } as never);
  const system = createAgentSystem({
    models,
    queryTools: {},
    agentFactory: ({ agentId }) => fakeAgent(agentId),
    accountingAgentFactory: (config) => fakeAgent(String(config.id)),
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
          'run_01JNZQ4A9B8C7D6E5F4G3H2J4K',
          'run_01JNZQ4A9B8C7D6E5F4G3H2J5K',
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
          'artifact_01JNZQ4A9B8C7D6E5F4G3H2J3K',
          'artifact_01JNZQ4A9B8C7D6E5F4G3H2J4K',
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
  const teamRuntime: OrchestratorTeamRuntime = {
    runTeamLead: vi.fn(async (runtimeInput) => {
      const leadSkill = accountingSkills.find((skill) => skill.identity.skillName === 'accounting-lead-routing')!.identity;
      const plan = await planner.plan({
        householdId,
        taskId,
        team: accountingTeamDefinition,
        selectedSkill: leadSkill,
        request: runtimeInput.request,
        policyLabels: ['personalized_finance'],
        abortSignal: runtimeInput.signal,
      });
      const workCell = accountingTeamDefinition.workCells.find((cell) => cell.workCellId === plan.work[0]!.workCellId)!;
      const selectedSkill = skillFor(workCell.allowedSkillNames[0]!);
      return coordinator.execute({
        team: accountingTeamDefinition,
        strategyName: plan.recommendedStrategyName,
        selectedSkill: selectedSkill.identity,
        resultTaskId,
        work: [{
          householdId,
          taskId,
          team: 'accounting',
          workCell,
          selectedSkill: selectedSkill.identity,
          makerInput: plan.work[0]!.makerInput,
          permittedEvidence: [],
          policyLabels: ['personalized_finance'],
          stopCondition: plan.stopCondition,
          strategyName: plan.recommendedStrategyName,
          abortSignal: runtimeInput.signal,
        }],
        stopCondition: plan.stopCondition,
      });
    }),
  };
  let teamResult: TeamResultEnvelopeV1 | undefined;
  const generate = vi.fn(async () => {
    teamResult = await executeDelegate(orchestrator.agentTools.delegateTeam, {
      team: 'accounting',
      request: {
        schemaName: 'accounting-lead-request',
        schemaVersion: 1,
        intent: input.intent,
        request: { householdId, bookId },
      },
    });
    return { object: OrchestratorFinalResponseSchemaV1.parse({
      schemaName: 'orchestrator-final-response',
      schemaVersion: 1,
      responseId: 'response-2026-06-23-001',
      householdId,
      conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      body: 'Accounting team status: ' + teamResult.status
        + (input.workCellId === 'chart-of-accounts' ? '; external confirmation required before commit.' : ''),
      policyBoundary: 'personalized_finance',
      citations: teamResult.claims.length === 0
        ? [{ label: 'accounting:team-result', sourceRef: 'team-result:' + teamResult.status }]
        : teamResult.claims.map((claim) => ({
          label: 'accounting:' + claim.claimId,
          artifactId: claim.checkedMakerArtifactIds[0]!,
        })),
      assumptions: [],
      freshness: teamResult.freshness.length === 0 ? ['current invocation'] : teamResult.freshness,
      disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
      unsupportedCapabilities: [],
      recommendationActions: [],
      delivery: { channel: 'telegram', destination: { chatId: 'telegram-chat-42' }, format: 'plain_text' },
      responseHash: 'c'.repeat(64),
      createdAt: now,
    }) };
  });
  const orchestrator = new OrchestratorAgent({
    model: models.orchestrator,
    agentFactory: (config) => ({ ...config, generate }) as never,
    teams: [accountingTeamDefinition],
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
    body: 'Handle accounting request.',
    attachments: [],
    metadata: { destination: { chatId: 'telegram-chat-42' } },
  }) });
  expect(teamRuntime.runTeamLead).toHaveBeenCalledWith(expect.objectContaining({ team: accountingTeamDefinition }));
  return { calls, response, teamResult: teamResult!, verificationLedger };
}

async function executeDelegate(
  tool: typeof OrchestratorAgent.prototype.agentTools.delegateTeam,
  input: { team: string; request: unknown },
): Promise<TeamResultEnvelopeV1> {
  const execute = tool.execute as unknown as (input: unknown, options: unknown) => Promise<unknown>;
  return TeamResultEnvelopeSchemaV1.parse(await execute(input, {}));
}

function skillFor(name: string): SkillRegistration {
  const skill = [...accountingSkills, ...ingestionSkills].find((entry) => entry.identity.skillName === name);
  if (skill === undefined) throw new Error('Missing skill ' + name);
  return skill;
}

function makerOutputFor(
  workCellId: 'transaction-capture' | 'ingestion' | 'journal' | 'chart-of-accounts' | 'reconciliation',
  kind: 'accepted' | 'clarification',
  suffix = 'initial',
): MakerArtifactV1 {
  const outputSchema = outputSchemaFor(workCellId);
  const output = outputFor(workCellId, kind);
  return MakerArtifactSchemaV1.parse({
    schemaName: 'maker-artifact',
    schemaVersion: 1,
    outputSchema,
    output,
    claims: [{
      claimId: workCellId + '-' + suffix,
      text: workCellId + ' maker produced ' + suffix + ' checked output.',
      evidenceArtifactIds: [],
    }],
    assumptions: [],
    uncertainty: [],
  });
}

function outputSchemaFor(workCellId: string) {
  if (workCellId === 'chart-of-accounts') return { schemaName: 'chart-of-accounts-proposal', schemaVersion: 1 };
  if (workCellId === 'ingestion') return { schemaName: 'ingestion-work-result', schemaVersion: 1 };
  if (workCellId === 'reconciliation') return { schemaName: 'reconciliation-work-result', schemaVersion: 1 };
  return { schemaName: 'accounting-work-result', schemaVersion: 1 };
}

function makerInputFor(workCellId: string): JsonValue {
  if (workCellId === 'ingestion') {
    return {
      schemaName: 'ingestion-work-request',
      schemaVersion: 1,
      householdId,
      importBatchId: 'import_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      checkedSourceArtifact: sourceArtifact(),
    };
  }
  if (workCellId === 'reconciliation') {
    return {
      schemaName: 'reconciliation-work-request',
      schemaVersion: 1,
      householdId,
      bookId,
      accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      statementSnapshotId: 'snapshot_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      checkedEvidenceArtifacts: [sourceArtifact()],
      requestedOperation: 'reconcile',
    };
  }
  if (workCellId === 'chart-of-accounts') {
    return {
      schemaName: 'chart-work-request',
      schemaVersion: 1,
      householdId,
      bookId,
      instruction: 'Create a groceries expense account.',
    };
  }
  if (workCellId === 'journal') {
    return {
      schemaName: 'journal-work-request',
      schemaVersion: 1,
      householdId,
      bookId,
      operation: 'post',
      instruction: 'Post a grocery purchase.',
    };
  }
  return {
    schemaName: 'transaction-capture-request',
    schemaVersion: 1,
    householdId,
    bookId,
    explicitInstruction: true,
    instruction: 'Capture a 12.34 USD grocery purchase paid from checking.',
    known: {
      amount: '12.34',
      currency: 'USD',
      paymentAccountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      occurredOn: '2026-06-23',
      categoryAccountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
    },
  };
}

function outputFor(workCellId: string, kind: 'accepted' | 'clarification'): JsonValue {
  if (kind === 'clarification') {
    if (workCellId === 'ingestion') return IngestionClarificationSchemaV1.parse({
      schemaName: 'ingestion-clarification',
      schemaVersion: 1,
      unresolvedNormalizedRowIds: ['normrow_01JNZQ4A9B8C7D6E5F4G3H2J1K'],
      questions: ['Which existing transaction should this probable duplicate link to?'],
      reason: 'Probable duplicate requires household confirmation.',
    });
    if (workCellId === 'reconciliation') return ReconciliationClarificationSchemaV1.parse({
      schemaName: 'reconciliation-clarification',
      schemaVersion: 1,
      missingEvidence: ['statement closing balance'],
      reason: 'The checked statement snapshot is incomplete.',
    });
    return AccountingClarificationSchemaV1.parse({
      schemaName: 'accounting-clarification',
      schemaVersion: 1,
      missingFields: ['payment_account'],
      questions: ['Which account paid for this transaction?'],
      reason: 'Payment account is material and unresolved.',
    });
  }
  if (workCellId === 'ingestion') return IngestionWorkResultSchemaV1.parse(ConfirmImportBatchProposalSchemaV1.parse({
    schemaName: 'confirm-import-batch-proposal',
    schemaVersion: 1,
    householdId,
    importBatchId: 'import_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    batchVersion: 1,
    decisions: [{
      normalizedRowId: 'normrow_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      action: 'defer',
      reasonCode: 'probable_duplicate_requires_confirmation',
    }],
  })) as unknown as JsonValue;
  if (workCellId === 'reconciliation') return ReconciliationWorkResultSchemaV1.parse(ReconciliationProposalSchemaV1.parse({
    schemaName: 'reconciliation-proposal',
    schemaVersion: 1,
    reconciliationId: 'recon_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    householdId,
    bookId,
    accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    statementSnapshotId: 'snapshot_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    periodStart: '2026-06-01',
    periodEnd: '2026-06-23',
    currency: 'USD',
    ledgerOpeningBalance: '100.00',
    ledgerClosingBalance: '87.66',
    statementOpeningBalance: '100.00',
    statementClosingBalance: '87.66',
    evidenceArtifactIds: ['artifact_01JNZQ4A9B8C7D6E5F4G3H2J9K'],
    items: [],
    unresolvedDiscrepancies: [],
    completionStatus: 'reconciled',
  })) as unknown as JsonValue;
  if (workCellId === 'chart-of-accounts') return ChartOfAccountsProposalSchemaV1.parse({
    schemaName: 'chart-of-accounts-proposal',
    schemaVersion: 1,
    action: 'create_account',
    householdId,
    bookId,
    accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J3K',
    name: 'Groceries',
    purpose: 'Household grocery spending.',
    accountingClass: 'expense',
    normalBalance: 'debit',
    nativeCurrency: 'USD',
  }) as unknown as JsonValue;
  return AccountingWorkResultSchemaV1.parse({
    schemaName: 'accounting-journal-mutation-proposal',
    schemaVersion: 1,
    operation: 'post',
    draft: {
      draftSeriesId: 'draftseries_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      version: 1,
      journal: {
        schemaName: 'post-journal-proposal',
        schemaVersion: 1,
        householdId,
        bookId,
        journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        periodId: 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        taskId,
        journalType: 'ordinary',
        transactionCurrency: 'USD',
        occurredOn: '2026-06-23',
        effectiveOn: '2026-06-23',
        description: 'Groceries paid from checking.',
        tagIds: [],
        postings: [
          {
            accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
            direction: 'debit',
            transactionAmount: '12.34',
            accountNativeAmount: '12.34',
            accountNativeCurrency: 'USD',
            memo: 'Groceries',
            tagIds: [],
          },
          {
            accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
            direction: 'credit',
            transactionAmount: '12.34',
            accountNativeAmount: '12.34',
            accountNativeCurrency: 'USD',
            memo: 'Checking',
            tagIds: [],
          },
        ],
      },
    },
  }) as unknown as JsonValue;
}

function sourceArtifact(): ArtifactEnvelopeV1 {
  return ArtifactEnvelopeSchemaV1.parse({
    artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J9K',
    householdId,
    taskId,
    artifactType: 'evidence_package',
    schema: { schemaName: 'source-evidence', schemaVersion: 1 },
    canonicalizationVersion: 'rfc8785-v1',
    hashAlgorithm: 'sha256',
    artifactHash: hash,
    payload: { source: 'test' },
    createdAt: now,
  });
}
