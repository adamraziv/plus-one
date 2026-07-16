import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Agent } from '@mastra/core/agent';
import { TokenLimiter } from '@mastra/core/processors';
import {
  InboundChannelMessageSchemaV1,
  MakerArtifactSchemaV1,
  OpaqueIdentifierDefinitions,
  QueryResultSchemaV1,
  TeamResultEnvelopeSchemaV2,
  type TeamResultEnvelopeV2,
} from '@plus-one/contracts';
import { configureLogging, withLogContext, type TeamDefinition } from '@plus-one/runtime';
import { confirmationDecision, OrchestratorAgent } from '../src/agents/orchestrator.js';
import type { OrchestratorSessionMemoryPort } from '../src/memory/orchestrator-session-memory.js';
import { internalIdentifierMatchCategory } from '../src/safety/internal-identifier.js';
import { finalSynthesisTeamResultView, type OrchestratorTeamRuntime } from '../src/tools/delegate-team.js';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const conversationId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const taskId = 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const artifactId = 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const draftId = 'draft_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const artifactHash = 'a'.repeat(64);
const now = '2026-06-23T10:00:00.000Z';

const queryTeam = {
  team: 'query',
  lead: {
    identity: { roleName: 'query-lead', roleVersion: 1 },
    kind: 'lead',
    agentId: 'query-lead',
    runtimePolicy: { policyName: 'query-lead', policyVersion: 1 },
  },
  charter: 'Provide checked evidence.',
  prohibitedBehavior: [],
  workCells: [],
  allowedStrategyNames: ['single-maker-checker'],
} as TeamDefinition;

const accountingTeam = {
  team: 'accounting',
  lead: {
    identity: { roleName: 'accounting-lead', roleVersion: 1 },
    kind: 'lead',
    agentId: 'accounting-lead',
    runtimePolicy: { policyName: 'accounting-lead', policyVersion: 1 },
  },
  charter: 'Convert explicit accounting instructions into checked mutation work.',
  prohibitedBehavior: [],
  workCells: [],
  allowedStrategyNames: ['single-maker-checker'],
} as TeamDefinition;

function message(body: string) {
  return InboundChannelMessageSchemaV1.parse({
    schemaName: 'inbound-channel-message',
    schemaVersion: 1,
    conversationId,
    householdId,
    channel: 'telegram',
    externalMessageId: 'telegram-message-1',
    receivedAt: now,
    speaker: { principalRef: 'telegram:user:1' },
    body,
    attachments: [],
    metadata: { destination: { chatId: 'telegram-chat-42' } },
  });
}

function teamResult(team: 'accounting' | 'query' = 'query') {
  return TeamResultEnvelopeSchemaV2.parse({
    schemaName: 'team-result',
    schemaVersion: 2,
    householdId,
    taskId,
    team,
    status: 'verified',
    claims: [{
      claimId: 'accounts-listed',
      text: 'The checked evidence includes one account row.',
      evidenceArtifactIds: [],
      checkedMakerArtifactIds: [artifactId],
    }],
    assumptions: [],
    uncertainty: [],
    freshness: [`${team} refreshed ${now}`],
    coverage: ['query'],
    makerArtifacts: [{
      artifactId,
      householdId,
      taskId,
      artifactType: 'maker_output',
      schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
      canonicalizationVersion: 'rfc8785-v1',
      hashAlgorithm: 'sha256',
      artifactHash,
      payload: MakerArtifactSchemaV1.parse({
        schemaName: 'maker-artifact',
        schemaVersion: 1,
        outputSchema: { schemaName: 'query-result', schemaVersion: 1 },
        output: { answer: 'one account' },
        claims: [{ claimId: 'accounts-listed', text: 'one account row', evidenceArtifactIds: [] }],
        assumptions: [],
        uncertainty: [],
      }),
      createdAt: now,
    }],
    checkerVerdicts: [{ verdict: 'accepted', coveredArtifactId: artifactId, coveredArtifactHash: artifactHash, findings: [] }],
    selectedSkill: { skillName: 'query-evidence', skillVersion: 1, contentHash: 'b'.repeat(64) },
    strategyName: 'single-maker-checker',
    stopCondition: { code: 'query-answer', description: 'Return one checked query answer.' },
    completionReason: 'Ready for orchestrator reconciliation.',
    outstanding: [],
    effect: { state: 'none' },
  });
}

function pendingChartTeamResult(input: {
  name?: string;
  accountingClass?: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  normalBalance?: 'debit' | 'credit';
  nativeCurrency?: string;
  claimText?: string;
} = {}) {
  const base = teamResult('accounting');
  const proposal = {
    schemaName: 'chart-of-accounts-proposal' as const,
    schemaVersion: 1 as const,
    action: 'create_account' as const,
    householdId,
    bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    name: input.name ?? 'Bank ABC',
    accountingClass: input.accountingClass ?? 'asset',
    normalBalance: input.normalBalance ?? 'debit',
    nativeCurrency: input.nativeCurrency ?? 'IDR',
  };
  const claimText = input.claimText ?? 'The chart proposal was checked.';
  const makerArtifacts = [{
    ...base.makerArtifacts[0]!,
    payload: MakerArtifactSchemaV1.parse({
      schemaName: 'maker-artifact',
      schemaVersion: 1,
      outputSchema: { schemaName: 'chart-work-result', schemaVersion: 1 },
      output: proposal,
      claims: [{ claimId: 'chart-proposal', text: claimText, evidenceArtifactIds: [] }],
      assumptions: [],
      uncertainty: [],
    }),
  }];
  return TeamResultEnvelopeSchemaV2.parse({
    ...base,
    status: 'partial',
    claims: [{
      claimId: 'chart-proposal',
      text: claimText,
      evidenceArtifactIds: [],
      checkedMakerArtifactIds: [artifactId],
    }],
    makerArtifacts,
    completionReason: 'The exact chart proposal passed checking.',
    effect: {
      state: 'awaiting_confirmation',
      proposal: { taskId, artifactId, artifactHash },
      command: {
        schemaName: 'checked-command',
        schemaVersion: 1,
        commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        householdId,
        taskId,
        checkedProposalId: artifactId,
        checkedProposalHash: artifactHash,
        commandType: 'apply_chart_of_accounts_change',
        idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        payloadSchema: { schemaName: 'chart-of-accounts-proposal', schemaVersion: 1 },
        payload: proposal,
      },
    },
  });
}

function persistedChartTeamResult() {
  const pending = pendingChartTeamResult();
  if (pending.effect.state !== 'awaiting_confirmation') throw new Error('Expected pending chart result');
  return TeamResultEnvelopeSchemaV2.parse({
    ...pending,
    status: 'verified',
    completionReason: 'The checked chart change was committed and read back successfully.',
    effect: {
      state: 'persisted',
      proposal: pending.effect.proposal,
      receipt: {
        schemaName: 'mutation-receipt',
        schemaVersion: 1,
        receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        commandId: pending.effect.command.commandId,
        householdId,
        taskId,
        checkedProposalId: artifactId,
        checkedProposalHash: artifactHash,
        commandType: pending.effect.command.commandType,
        idempotencyKey: pending.effect.command.idempotencyKey,
        committedRecords: [{
          recordType: 'accounting.account',
          recordId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        }],
        expectedState: pending.effect.command.payload,
        expectedStateHash: 'c'.repeat(64),
        committedAt: now,
      },
      readback: {
        schemaName: 'mutation-readback',
        schemaVersion: 1,
        readbackId: 'readback_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        commandId: pending.effect.command.commandId,
        receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        ok: true,
        checks: [{ kind: 'idempotency_receipt', status: 'passed' }],
        mismatches: [],
        observedStateHash: 'd'.repeat(64),
      },
    },
  });
}

const addAccountMessage = message('Add Bank ABC as an IDR asset account.');

function finalSynthesisProjectionResult(relationName = 'reporting.categorized_transactions') {
  return TeamResultEnvelopeSchemaV2.parse({
    ...teamResult(),
    claims: [
      {
        claimId: 'checking-account',
        text: 'Checking is configured for this household.',
        evidenceArtifactIds: [],
        checkedMakerArtifactIds: [artifactId],
      },
      {
        claimId: 'unsafe-claim',
        text: 'Use account_private_001 to continue.',
        evidenceArtifactIds: [],
        checkedMakerArtifactIds: [artifactId],
      },
      {
        claimId: 'unsafe-draft-claim',
        text: `Use ${draftId} to continue.`,
        evidenceArtifactIds: [],
        checkedMakerArtifactIds: [artifactId],
      },
    ],
    assumptions: [
      'Amounts are shown in USD.',
      `The household identifier is ${householdId}.`,
    ],
    uncertainty: [
      'No additional uncertainty was reported.',
      'The Book ID is internal-only.',
    ],
    outstanding: [
      'You can review the checked result.',
      'Ask for account_private_001 if clarification is needed.',
      `The checked artifact is ${artifactId}.`,
    ],
    makerArtifacts: [{
      ...teamResult().makerArtifacts[0]!,
      payload: MakerArtifactSchemaV1.parse({
        schemaName: 'maker-artifact',
        schemaVersion: 1,
        outputSchema: { schemaName: 'query-result', schemaVersion: 1 },
        output: QueryResultSchemaV1.parse({
          schemaName: 'query-result',
          schemaVersion: 1,
          relationName,
          grain: ['household', 'posting'],
          rows: [{
            account_id: 'account_private_001',
            household_id: householdId,
            effective_on: '2026-06-23',
            account_name: 'Checking',
            accounting_class: 'asset',
            account_native_amount: '420.00',
            account_native_currency: 'USD',
            description: 'Use account_private_001 to continue.',
            account_private_001: 'internal account-key payload',
            account_secret: 'internal alphabetic account-key payload',
            draft_private_001: 'internal checker payload',
            draft_secret: 'internal alphabetic draft-key payload',
          }],
          fieldDefinitions: [
            'account_id',
            'household_id',
            'effective_on',
            'account_name',
            'accounting_class',
            'account_native_amount',
            'account_native_currency',
            'description',
            'account_private_001',
            'account_secret',
            'draft_private_001',
            'draft_secret',
          ],
          sourceReferences: [
            `relation=${relationName}`,
            `filter=household_id:eq:${householdId}`,
          ],
          freshness: 'latest available reporting projection',
          coverageWarnings: [],
        }),
        claims: [{
          claimId: 'checking-account',
          text: 'Checking is configured for this household.',
          evidenceArtifactIds: [],
        }],
        assumptions: [],
        uncertainty: [],
      }),
    }],
  });
}

function emptyCurrentBalancesResult() {
  const currentBalancesArtifactId = 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1M';
  const currentBalancesArtifactHash = 'c'.repeat(64);
  const currentBalances = QueryResultSchemaV1.parse({
    schemaName: 'query-result',
    schemaVersion: 1,
    relationName: 'reporting.current_balances',
    grain: ['household', 'account'],
    rows: [],
    fieldDefinitions: ['account_id', 'native_amount'],
    sourceReferences: [
      'relation=reporting.current_balances',
      `filter=household_id:eq:${householdId}`,
    ],
    freshness: 'latest available reporting projection',
    coverageWarnings: [],
  });

  return TeamResultEnvelopeSchemaV2.parse({
    ...teamResult(),
    claims: [{
      claimId: 'current-balance-rows',
      text: 'The checked current-balance projection returned no rows.',
      evidenceArtifactIds: [],
      checkedMakerArtifactIds: [currentBalancesArtifactId],
    }],
    freshness: ['reporting.current_balances refreshed 2026-06-23T10:00:00.000Z'],
    coverage: ['balance snapshot'],
    makerArtifacts: [{
      artifactId: currentBalancesArtifactId,
      householdId,
      taskId,
      artifactType: 'maker_output',
      schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
      canonicalizationVersion: 'rfc8785-v1',
      hashAlgorithm: 'sha256',
      artifactHash: currentBalancesArtifactHash,
      payload: MakerArtifactSchemaV1.parse({
        schemaName: 'maker-artifact',
        schemaVersion: 1,
        outputSchema: { schemaName: 'query-result', schemaVersion: 1 },
        output: currentBalances,
        claims: [{
          claimId: 'current-balance-rows',
          text: 'The checked current-balance projection returned no rows.',
          evidenceArtifactIds: [],
        }],
        assumptions: [],
        uncertainty: [],
      }),
      createdAt: now,
    }],
    checkerVerdicts: [{
      verdict: 'accepted',
      coveredArtifactId: currentBalancesArtifactId,
      coveredArtifactHash: currentBalancesArtifactHash,
      findings: [],
    }],
    completionReason: 'The checked current-balance projection returned no rows.',
    outstanding: [
      'The account inventory remains established separately from the current-balance projection.',
    ],
  });
}

function insufficientEvidenceResult(team: 'accounting' | 'query' = 'accounting') {
  return TeamResultEnvelopeSchemaV2.parse({
    ...teamResult(team),
    status: 'insufficient_evidence',
    claims: [],
    makerArtifacts: [{
      ...teamResult(team).makerArtifacts[0]!,
      payload: MakerArtifactSchemaV1.parse({
        schemaName: 'maker-artifact',
        schemaVersion: 1,
        outputSchema: { schemaName: 'chart-work-result', schemaVersion: 1 },
        output: {
          schemaName: 'chart-clarification',
          schemaVersion: 1,
          missingFields: ['native_currency'],
          questions: ['What is its native currency?'],
          reason: 'A safe chart-of-accounts proposal requires the unresolved user-owned fields.',
        },
        claims: [],
        assumptions: [],
        uncertainty: [],
      }),
    }],
    completionReason: 'A safe chart-of-accounts proposal requires the unresolved user-owned fields.',
    outstanding: ['What is its native currency?', 'native_currency'],
  });
}

function failedTeamResult() {
  return TeamResultEnvelopeSchemaV2.parse({
    ...teamResult(),
    status: 'failed',
    claims: [],
    makerArtifacts: [],
    checkerVerdicts: [],
    freshness: [],
    completionReason: 'The checker rejected the artifact or revision attempts were exhausted.',
    outstanding: ['grain mismatch'],
  });
}

function queryDraft(businessQuestion: string, extra: Record<string, unknown> = {}) {
  return {
    schemaName: 'query-lead-request-draft',
    schemaVersion: 1,
    businessQuestion,
    requiredCalculations: [],
    ...extra,
  };
}

function memoryMessage(role: 'user' | 'assistant', body: string) {
  return {
    id: `${role}-${body}`,
    role,
    createdAt: new Date('2026-06-30T00:00:00.000Z'),
    threadId: conversationId,
    resourceId: householdId,
    content: { format: 2 as const, parts: [{ type: 'text' as const, text: body }] },
  };
}

function singleLoopOrchestrator(input: {
  generate: (...args: unknown[]) => Promise<unknown>;
  runTeamLead: OrchestratorTeamRuntime['runTeamLead'];
  teams: readonly TeamDefinition[];
}) {
  return new OrchestratorAgent({
    model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
    agentFactory: (config) => ({ ...config, generate: input.generate }) as never,
    teams: input.teams,
    teamRuntime: testTeamRuntime(input.runTeamLead),
  });
}

function testTeamRuntime(runTeamLead: OrchestratorTeamRuntime['runTeamLead']): OrchestratorTeamRuntime {
  return {
    runTeamLead,
    resumePendingMutation: async () => { throw new Error('Unexpected mutation resume'); },
    cancelPendingMutation: async () => { throw new Error('Unexpected mutation cancellation'); },
  };
}

describe('OrchestratorAgent', () => {
  it('gives final synthesis checked proposal details and forbids past-tense persistence', async () => {
    const pending = pendingChartTeamResult({
      name: 'Bank ABC',
      accountingClass: 'asset',
      normalBalance: 'debit',
      nativeCurrency: 'IDR',
    });
    const prompts: string[] = [];
    const generate = vi.fn(async (prompt: unknown) => {
      prompts.push(JSON.stringify(prompt));
      if (generate.mock.calls.length === 1) {
        await executeDelegate(orchestrator.agentTools.delegateTeam, {
          team: 'accounting',
          request: {
            schemaName: 'accounting-lead-request',
            schemaVersion: 1,
            intent: 'chart_of_accounts',
            request: {
              schemaName: 'chart-work-request-draft',
              schemaVersion: 1,
              action: 'create_account',
              instruction: 'Add Bank ABC as an IDR asset account.',
              known: {
                accountName: 'Bank ABC',
                accountingClass: 'asset',
                normalBalance: 'debit',
                nativeCurrency: 'IDR',
              },
            },
          },
        });
        return { text: 'Bank ABC has been created successfully.' };
      }
      return { text: 'I’ll add Bank ABC as an IDR asset account with a normal debit balance. Would you like me to proceed?' };
    });
    const orchestrator = singleLoopOrchestrator({
      generate,
      runTeamLead: vi.fn(async () => pending),
      teams: [accountingTeam],
    });

    const turn = await orchestrator.runTurn({ message: addAccountMessage });

    expect(turn.kind).toBe('ask-user');
    expect(prompts.at(-1)).toContain('Bank ABC');
    expect(prompts.at(-1)).toContain('future tense');
    expect(prompts.at(-1)).toContain('Do not tell the user to reply with a specific word');
    expect(turn.response.body).toBe(
      'I’ll add Bank ABC as an IDR asset account with a normal debit balance. Would you like me to proceed?',
    );
  });

  it.each([
    ['yes', 'approve'],
    ['go ahead', 'approve'],
    ['please do', 'approve'],
    ['sounds good', 'approve'],
    ['no, cancel it', 'reject'],
    ['what does debit mean?', 'unclear'],
  ] as const)('classifies %s as %s for a suspended proposal', (body, expected) => {
    expect(confirmationDecision(body)).toBe(expected);
  });

  it('reports readback-verified account creation after confirmation', async () => {
    const pending = pendingChartTeamResult();
    const resumePendingMutation = vi.fn(async () => persistedChartTeamResult());
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      teams: [accountingTeam],
      teamRuntime: {
        runTeamLead: vi.fn(),
        resumePendingMutation,
        cancelPendingMutation: vi.fn(),
      },
    });

    const turn = await orchestrator.resolvePendingMutation({
      message: message('yes'),
      pending,
    });

    expect(turn).toMatchObject({
      kind: 'final',
      response: {
        body: 'I added Bank ABC as an IDR asset account with a normal debit balance.',
      },
    });
    expect(resumePendingMutation).toHaveBeenCalledOnce();
  });

  it('never exposes maker persistence claims while an effect is pending', () => {
    const view = finalSynthesisTeamResultView(pendingChartTeamResult({
      claimText: 'Bank ABC has been created successfully.',
    }));
    expect(view.checkedClaims).toEqual([]);
    expect(view.proposedChange).toMatchObject({ accountName: 'Bank ABC' });
  });

  it.each(Object.values(OpaqueIdentifierDefinitions))(
    'recognizes every contract-owned opaque identifier family in user-facing safety checks',
    (definition) => {
      expect(internalIdentifierMatchCategory(
        `Internal token: ${definition.prefix}_01JNZQ4A9B8C7D6E5F4G3H2J1K`,
      )).toBe('identifier_token');
    },
  );

  it('recognizes malformed tokens with a contract-owned opaque identifier prefix', () => {
    expect(internalIdentifierMatchCategory('Internal token: draft_private_001')).toBe('identifier_token');
  });

  it('logs turn lifecycle metadata while preserving inherited request context', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-orchestrator-'));
    const logging = configureLogging({ homeDirectory });
    const inbound = message('What did we spend this month?');
    const generate = vi.fn(async (_prompt: unknown, options: { onStepFinish?: (step: unknown) => void }) => {
      options.onStepFinish?.({ usage: { inputTokens: 10, outputTokens: 8 }, toolCalls: [] });
      return { text: 'Private final response body' };
    });
    const orchestrator = singleLoopOrchestrator({
      generate: generate as (...args: unknown[]) => Promise<unknown>,
      runTeamLead: vi.fn(),
      teams: [],
    });

    try {
      await withLogContext({ requestId: 'req_inherited' }, () => orchestrator.run({ message: inbound }));
      const agentLog = await readFile(join(homeDirectory, 'logs', 'agent.log'), 'utf8');
      expect(agentLog).toContain('turn.started');
      expect(agentLog).toContain('turn.context.prepared');
      expect(agentLog).toContain('orchestrator.step.completed');
      expect(agentLog).toContain('durationMs=');
      expect(agentLog).toContain('turn.completed');
      expect(agentLog).toContain('requestId=req_inherited');
      expect(agentLog).toContain('conversationId=conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K');
      expect(agentLog).toContain('householdId=hh_01JNZQ4A9B8C7D6E5F4G3H2J1K');
      expect(agentLog).not.toContain('What did we spend this month?');
      expect(agentLog).not.toContain('Private final response body');
    } finally {
      logging.close();
    }
  });

  it('logs a sanitized failed turn without serializing the thrown message', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-orchestrator-'));
    const logging = configureLogging({ homeDirectory });
    const generate = vi.fn(async () => {
      throw new Error('Private model response should not be logged');
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead: vi.fn(), teams: [] });

    try {
      await expect(orchestrator.run({ message: message('What did we spend this month?') }))
        .rejects.toThrow('Private model response should not be logged');
      const agentLog = await readFile(join(homeDirectory, 'logs', 'agent.log'), 'utf8');
      expect(agentLog).toContain('turn.failed');
      expect(agentLog).toContain('failureCategory=runtime_failure');
      expect(agentLog).not.toContain('Private model response should not be logged');
      expect(agentLog).not.toContain('What did we spend this month?');
    } finally {
      logging.close();
    }
  });

  it('limits model construction to the top-level orchestrator agent', () => {
    const configs: Array<{
      id: string | undefined;
      inputProcessors: unknown;
      tools: unknown;
      maxRetries: number | undefined;
    }> = [];

    new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => {
        configs.push({
          id: config.id,
          inputProcessors: config.inputProcessors,
          tools: config.tools,
          maxRetries: config.maxRetries,
        });
        return { ...config, generate: vi.fn() } as never;
      },
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(vi.fn()),
    });

    expect(configs.map(({ id }) => id)).toEqual(['orchestrator']);
    expect(configs[0]).toMatchObject({ maxRetries: 0 });
    expect(configs[0]?.tools).toEqual(expect.objectContaining({ delegateTeam: expect.anything() }));
    const processors = configs[0]?.inputProcessors;
    expect(Array.isArray(processors)).toBe(true);
    if (!Array.isArray(processors)) throw new Error('Expected orchestrator input processors.');
    expect(processors).toHaveLength(1);
    expect(processors[0]).toBeInstanceOf(TokenLimiter);
    expect((processors[0] as TokenLimiter).getMaxTokens()).toBe(24_000);
  });

  it('defines account routing semantics in its instructions', () => {
    let orchestratorInstructions: string | undefined;

    new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => {
        if (typeof config.instructions !== 'string') throw new Error('Expected orchestrator instructions to be a string.');
        orchestratorInstructions = config.instructions;
        return { ...config, generate: vi.fn() } as never;
      },
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(vi.fn()),
    });

    expect(orchestratorInstructions).toContain(
      'Account existence or account inventory questions use account list coverage.',
    );
    expect(orchestratorInstructions).toContain(
      'Use balance snapshot only when the user explicitly asks for a balance, amount, value, or net worth.',
    );
    expect(orchestratorInstructions).toContain(
      'Coverage labels must be copied verbatim from the coverage map as lowercase space-separated governed strings and must never be converted to underscore aliases; use "balance snapshot", never "balance_snapshot".',
    );
    expect(orchestratorInstructions).toContain(
      'Never ask for, expose, repeat, quote, or include internal household, book, account, or system identifiers in any user-facing response; use user-visible names or safe clarifying questions instead.',
    );
    expect(orchestratorInstructions).toContain(
      'An empty reporting.current_balances result does not prove that no accounts exist.',
    );
    expect(orchestratorInstructions).toContain(
      'Do not infer entity absence from an empty metric projection.',
    );
    expect(orchestratorInstructions).toContain(
      'Account creation and chart changes always require checked specialist work; call delegateTeam instead of answering directly or collecting fields yourself.',
    );
    expect(orchestratorInstructions).toContain(
      'For account creation or chart changes, use the accounting team with intent chart_of_accounts and a nested chart-work-request-draft.',
    );
  });

  it('uses prepared thread context and persists the final user-facing reply', async () => {
    const sessionMemory: OrchestratorSessionMemoryPort = {
      prepareInput: vi.fn(async () => [
        memoryMessage('assistant', 'Earlier clean reply'),
        memoryMessage('user', 'Use checking for that transfer.'),
      ]),
      persistTurn: vi.fn(),
      close: vi.fn(),
    };
    const generate = vi.fn(async (messages: unknown) => {
      expect(messages).toEqual([
        expect.objectContaining({ role: 'assistant' }),
        expect.objectContaining({ role: 'user' }),
      ]);
      return { text: 'Final clean answer.' };
    });
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      sessionMemory,
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(vi.fn()),
    });

    await expect(orchestrator.run({ message: message('Use checking for that transfer.') }))
      .resolves.toMatchObject({ body: 'Final clean answer.' });
    expect(sessionMemory.prepareInput).toHaveBeenCalledWith({
      message: message('Use checking for that transfer.'),
    });
    expect(sessionMemory.persistTurn).toHaveBeenCalledWith({
      message: message('Use checking for that transfer.'),
      assistantText: 'Final clean answer.',
    });
  });

  it('keeps the full checked team result for citations while exposing only a safe final-synthesis view to the model', async () => {
    const result = finalSynthesisProjectionResult();
    let delegated: TeamResultEnvelopeV2 | undefined;
    let modelOutput: unknown;
    const generate = vi.fn(async () => {
      delegated = await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('Show our recent transactions.', { coverage: ['categorized transactions'] }),
      });
      const toModelOutput = orchestrator.agentTools.delegateTeam.toModelOutput;
      if (toModelOutput !== undefined) modelOutput = toModelOutput(delegated);
      return { text: 'Checking is configured for this household.' };
    });
    const orchestrator = singleLoopOrchestrator({
      generate,
      runTeamLead: vi.fn(async () => result),
      teams: [queryTeam],
    });

    const response = await orchestrator.run({ message: message('Show our recent transactions.') });

    expect(delegated).toMatchObject({
      householdId,
      taskId,
      makerArtifacts: [expect.objectContaining({
        artifactId,
        artifactHash,
        payload: expect.objectContaining({
          output: expect.objectContaining({
            rows: [expect.objectContaining({ account_id: 'account_private_001' })],
          }),
        }),
      })],
    });
    expect(response.citations).toEqual(expect.arrayContaining([
      { label: 'query:checking-account', artifactId },
      { label: 'query:unsafe-claim', artifactId },
    ]));
    expect(typeof orchestrator.agentTools.delegateTeam.toModelOutput).toBe('function');
    expect(modelOutput).toMatchObject({
      type: 'json',
      value: {
        schemaName: 'final-synthesis-team-result',
        schemaVersion: 1,
        team: 'query',
        status: 'verified',
        checkedClaims: expect.arrayContaining([
          'Checking is configured for this household.',
          'Some checked details were withheld for privacy.',
        ]),
        assumptions: expect.arrayContaining(['Amounts are shown in USD.']),
        uncertainty: expect.arrayContaining(['No additional uncertainty was reported.']),
        outstanding: expect.arrayContaining(['You can review the checked result.']),
        checkedData: [{
          checkedClaim: 'Checking is configured for this household.',
          rows: [{
            'effective on': '2026-06-23',
            'account name': 'Checking',
            'accounting class': 'asset',
            'account native amount': '420.00',
            'account native currency': 'USD',
            description: 'Some checked details were withheld for privacy.',
          }],
        }],
      },
    });
    const serializedView = JSON.stringify(modelOutput);
    expect(serializedView.includes(householdId)).toBe(false);
    expect(serializedView.includes(taskId)).toBe(false);
    expect(serializedView.includes(artifactId)).toBe(false);
    expect(serializedView.includes(artifactHash)).toBe(false);
    expect(serializedView.includes(draftId)).toBe(false);
    expect(serializedView.includes('draft_private_001')).toBe(false);
    expect(serializedView.includes('internal checker payload')).toBe(false);
    expect(serializedView.includes('account_private_001')).toBe(false);
    expect(serializedView.includes('internal account-key payload')).toBe(false);
    expect(serializedView.includes('account_secret')).toBe(false);
    expect(serializedView.includes('internal alphabetic account-key payload')).toBe(false);
    expect(serializedView.includes('draft_secret')).toBe(false);
    expect(serializedView.includes('internal alphabetic draft-key payload')).toBe(false);
    expect(serializedView.includes('account_id')).toBe(false);
    expect(serializedView.includes('household_id')).toBe(false);
    expect(serializedView.includes('reporting.categorized_transactions')).toBe(false);
    expect(serializedView.includes('single-maker-checker')).toBe(false);
    expect(serializedView.includes('query-evidence')).toBe(false);
    expect(serializedView.includes('query-answer')).toBe(false);
    expect(serializedView.includes('Ready for orchestrator reconciliation.')).toBe(false);
  });

  it('does not grant categorized transaction field capability to another reporting relation', () => {
    const orchestrator = singleLoopOrchestrator({
      generate: vi.fn(async () => ({ text: 'Unused.' })),
      runTeamLead: vi.fn(),
      teams: [queryTeam],
    });
    const toModelOutput = orchestrator.agentTools.delegateTeam.toModelOutput;
    if (toModelOutput === undefined) throw new Error('Expected delegateTeam to provide model output.');

    const modelOutput = toModelOutput(finalSynthesisProjectionResult('reporting.accounts'));
    const serializedView = JSON.stringify(modelOutput);

    expect(serializedView.includes('account_name')).toBe(false);
    expect(serializedView.includes('account_native_amount')).toBe(false);
    expect(serializedView.includes('account_native_currency')).toBe(false);
    expect(serializedView.includes('draft_secret')).toBe(false);
    expect(serializedView.includes('account_secret')).toBe(false);
  });

  it('maps a Mastra input-validation wrapper to a safe retry signal without consuming delegation', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    let modelOutput: unknown;
    const generate = vi.fn(async (_prompt: unknown, rawOptions: unknown) => {
      const options = rawOptions as {
        prepareStep(): Promise<{ activeTools: string[]; toolChoice: string }> | { activeTools: string[]; toolChoice: string };
      };
      const execute = orchestrator.agentTools.delegateTeam.execute as unknown as
        (input: unknown, options: unknown) => Promise<unknown>;
      const invalidResult = await execute({ team: 'query', request: 'account_private_001' }, {});
      expect(invalidResult).toMatchObject({ error: true });
      await expect(options.prepareStep()).resolves.toEqual({
        activeTools: ['delegateTeam'],
        toolChoice: 'auto',
      });
      const toModelOutput = orchestrator.agentTools.delegateTeam.toModelOutput as
        | ((output: unknown) => unknown)
        | undefined;
      if (toModelOutput === undefined) throw new Error('Expected delegateTeam to provide model output.');
      modelOutput = toModelOutput(invalidResult);
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.', { coverage: ['account list'] }),
      });
      await expect(options.prepareStep()).resolves.toEqual({
        activeTools: [],
        toolChoice: 'none',
      });
      return { text: 'The checked evidence includes one account row.' };
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('List our accounts.') }))
      .resolves.toMatchObject({ body: 'The checked evidence includes one account row.' });

    expect(runTeamLead).toHaveBeenCalledOnce();
    expect(modelOutput).toEqual({
      type: 'json',
      value: {
        schemaName: 'delegate-team-retry-signal',
        schemaVersion: 1,
        status: 'retry_required',
        instruction: 'Retry delegateTeam with an exact registered team id and a JSON-object request matching that team\'s declared schema.',
      },
    });
    const serializedModelOutput = JSON.stringify(modelOutput);
    expect(serializedModelOutput).not.toContain('account_private_001');
    expect(serializedModelOutput).not.toContain('validationErrors');
    expect(serializedModelOutput).not.toContain('Tool input validation failed');
    expect(serializedModelOutput).not.toContain('Provided arguments');
  });

  it('uses a real Mastra step sequence to retry invalid delegation before final synthesis', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const modelCalls: unknown[] = [];
    const modelSteps = [
      {
        finishReason: 'tool-calls' as const,
        content: [{
          type: 'tool-call' as const,
          toolCallId: 'invalid-delegation',
          toolName: 'delegateTeam',
          input: JSON.stringify({ team: 'query', request: draftId }),
        }],
      },
      {
        finishReason: 'tool-calls' as const,
        content: [{
          type: 'tool-call' as const,
          toolCallId: 'valid-delegation',
          toolName: 'delegateTeam',
          input: JSON.stringify({
            team: 'query',
            request: queryDraft('List our accounts.', { coverage: ['account list'] }),
          }),
        }],
      },
      {
        finishReason: 'stop' as const,
        content: [{ type: 'text' as const, text: 'Final synthesis after corrected delegation.' }],
      },
    ];
    const scriptedModel = {
      specificationVersion: 'v2' as const,
      provider: 'test',
      modelId: 'orchestrator-step-sequence',
      supportedUrls: {},
      doGenerate: vi.fn(async (options: unknown) => {
        modelCalls.push(options);
        const next = modelSteps.shift();
        if (next === undefined) throw new Error('Model received more steps than the test script permits.');
        return {
          ...next,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      }),
      doStream: async () => {
        throw new Error('The orchestrator test uses non-streaming generation.');
      },
    };
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => new Agent({ ...config, model: scriptedModel as never }),
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(runTeamLead),
    });

    const response = await orchestrator.run({ message: message('List our accounts.') });

    expect(response.body).toBe('Final synthesis after corrected delegation.');
    expect(response.body).not.toContain('The checked evidence includes one account row.');
    expect(runTeamLead).toHaveBeenCalledOnce();
    expect(scriptedModel.doGenerate).toHaveBeenCalledTimes(3);
    expect(modelCalls).toHaveLength(3);
  });

  it('passes only the user body into a non-memory model prompt', async () => {
    const body = 'What are the balances in my accounts?';
    let prompt: unknown;
    const generate = vi.fn(async (value: unknown) => {
      prompt = value;
      return { text: 'I will check the balances.' };
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead: vi.fn(), teams: [queryTeam] });

    await orchestrator.run({ message: message(body) });

    expect(typeof prompt === 'string').toBe(true);
    if (typeof prompt !== 'string') throw new Error('Expected a text-only prompt.');
    expect(prompt === body).toBe(true);
    expect(prompt.includes(householdId)).toBe(false);
    expect(prompt.includes(conversationId)).toBe(false);
    expect(prompt.includes('telegram-chat-42')).toBe(false);
  });

  it('records only an identifier match category when final response safety withholds a token', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-orchestrator-'));
    const logging = configureLogging({ homeDirectory });
    const generate = vi.fn(async () => ({ text: 'Please use account_private_001 to continue.' }));
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead: vi.fn(), teams: [queryTeam] });

    try {
      await expect(orchestrator.run({ message: message('Can you help?') }))
        .resolves.toMatchObject({ body: 'I could not prepare a safe response. Please try again.' });
      const agentLog = await readFile(join(homeDirectory, 'logs', 'agent.log'), 'utf8');
      expect(agentLog).toContain('orchestrator.response.withheld');
      expect(agentLog).toContain('matchCategory=identifier_token');
      expect(agentLog).not.toContain('account_private_001');
    } finally {
      logging.close();
    }
  });

  it('keeps checked account-list evidence separate from an empty current-balance projection during deterministic synthesis', async () => {
    let orchestratorInstructions: string | undefined;
    const preparedMessages = [
      memoryMessage('assistant', 'Checked account-list evidence established that Checking and Groceries are configured.'),
      memoryMessage('user', 'What are the balances in my accounts?'),
    ];
    const sessionMemory: OrchestratorSessionMemoryPort = {
      prepareInput: vi.fn(async () => preparedMessages),
      persistTurn: vi.fn(),
      close: vi.fn(),
    };
    const currentBalancesResult = emptyCurrentBalancesResult();
    const runTeamLead = vi.fn(async () => currentBalancesResult);
    const generate = vi.fn(async (messages: unknown) => {
      expect(messages).toEqual(preparedMessages);
      const delegated = await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('What are the balances in my accounts?', {
          desiredGrain: ['household', 'account'],
          coverage: ['balance snapshot'],
        }),
      });
      expect(delegated.makerArtifacts[0]?.payload).toMatchObject({
        output: { relationName: 'reporting.current_balances', rows: [] },
      });
      return { text: 'No current-balance rows were returned.' };
    });
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => {
        if (typeof config.instructions !== 'string') throw new Error('Expected orchestrator instructions to be a string.');
        orchestratorInstructions = config.instructions;
        return { ...config, generate } as never;
      },
      sessionMemory,
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(runTeamLead),
    });

    const response = await orchestrator.run({ message: message('What are the balances in my accounts?') });

    expect(orchestratorInstructions).toContain(
      'An empty reporting.current_balances result does not prove that no accounts exist.',
    );
    expect(orchestratorInstructions).toContain(
      'Do not infer entity absence from an empty metric projection. State only that the requested metric projection returned no rows.',
    );
    expect(orchestratorInstructions).toContain(
      'Only reporting.accounts account-list evidence may support a claim that no accounts are configured.',
    );
    expect(runTeamLead).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ coverage: ['balance snapshot'] }),
    }));
    expect(response.body).not.toMatch(/no accounts|no accounts set up|do not have accounts/i);
    expect(response.body).toBe('No current-balance rows were returned.');
  });

  it('allows four semantic model steps for two validation retries, delegation, and final synthesis', async () => {
    const generate = vi.fn(async () => ({
      text: 'Plus One can help with household finance questions.',
    }));
    const configs: Array<{ id?: string; tools?: unknown }> = [];
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => {
        configs.push(config);
        return { ...config, generate } as never;
      },
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(vi.fn()),
    });
    const signal = AbortSignal.timeout(1_000);

    await expect(orchestrator.run({ message: message('hi'), signal }))
      .resolves.toMatchObject({ body: 'Plus One can help with household finance questions.' });
    expect(configs.map(({ id }) => id)).toEqual(['orchestrator']);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      stopWhen: expect.any(Function),
      maxProcessorRetries: 2,
      errorProcessors: [expect.anything()],
      toolChoice: 'auto',
      abortSignal: signal,
    }));
    const [, options] = generate.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(options).not.toHaveProperty('structuredOutput');
    expect(options).not.toHaveProperty('maxRetries');
    expect(options).not.toHaveProperty('maxSteps');
    const stopWhen = options.stopWhen as (input: {
      steps: Array<{ finishReason?: string }>;
    }) => boolean;
    expect(stopWhen({ steps: [{ finishReason: 'retry' }, { finishReason: 'tool-calls' }] })).toBe(false);
    expect(stopWhen({ steps: [{ finishReason: 'tool-calls' }, { finishReason: 'stop' }] })).toBe(false);
    expect(stopWhen({ steps: [
      { finishReason: 'tool-calls' },
      { finishReason: 'tool-calls' },
      { finishReason: 'stop' },
    ] })).toBe(false);
    expect(stopWhen({ steps: [
      { finishReason: 'tool-calls' },
      { finishReason: 'tool-calls' },
      { finishReason: 'tool-calls' },
      { finishReason: 'stop' },
    ] })).toBe(true);
  });

  it('lets the single orchestrator generation delegate once and return checked reply text', async () => {
    const runTeamLead = vi.fn(async (input: Parameters<OrchestratorTeamRuntime['runTeamLead']>[0]) => {
      void input;
      return teamResult();
    });
    const generate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.', {
          desiredGrain: ['household', 'account'],
          coverage: ['account list'],
        }),
      });
      return { text: 'The checked evidence includes one account row.' };
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    const response = await orchestrator.run({ message: message('List our accounts.') });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(runTeamLead).toHaveBeenCalledTimes(1);
    expect(response.citations).toEqual([{ label: 'query:accounts-listed', artifactId }]);
  });

  it('sends an application-authored delegation bubble and returns only final-step text', async () => {
    const channelEvents = { emit: vi.fn(async (event: unknown) => { void event; }) };
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.', {
          desiredGrain: ['household', 'account'],
          coverage: ['account list'],
        }),
      });
      return {
        text: 'Let me check your household accounts for you!The checked evidence includes one account row.',
        steps: [
          { text: 'Let me check your household accounts for you!', toolCalls: [{ toolName: 'delegateTeam' }] },
          { text: 'The checked evidence includes one account row.', toolCalls: [] },
        ],
      };
    });
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(runTeamLead),
      channelEvents,
    });

    await expect(orchestrator.run({ message: message('List our accounts.') }))
      .resolves.toMatchObject({ body: 'The checked evidence includes one account row.' });

    const emitted = channelEvents.emit.mock.calls.map(([event]) => event);
    expect(emitted.slice(0, 2)).toEqual([
      expect.objectContaining({
        kind: 'assistant.commentary',
        body: "I'll check your household accounts.",
      }),
      expect.objectContaining({ kind: 'tool.started', toolName: 'delegateTeam' }),
    ]);
    expect(emitted).not.toContainEqual(
      expect.objectContaining({ body: 'Let me check your household accounts for you!' }),
    );
  });

  it('runs a dedicated synthesis pass when delegation consumes the last semantic step', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn()
      .mockImplementationOnce(async () => {
        await executeDelegate(orchestrator.agentTools.delegateTeam, {
          team: 'query', request: queryDraft('List our accounts.', { coverage: ['account list'] }),
        });
        return {
          text: 'Preamble that must never be a final response.',
          steps: [
            { text: 'Preamble that must never be a final response.', toolCalls: [{ toolName: 'delegateTeam' }] },
          ],
        };
      })
      .mockResolvedValueOnce({ text: 'I found one account in your household records.' });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    const response = await orchestrator.run({ message: message('List our accounts.') });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(response.body).toBe('I found one account in your household records.');
    expect(response.body).not.toContain('Preamble that must never be a final response.');
    expect(response.body).not.toMatch(/reporting\.|QueryResultV1|checker|maker|team status|native_currency/i);
  });

  it('uses the last semantic step for a direct answer', async () => {
    const generate = vi.fn(async () => ({
      text: 'Earlier draft.Final direct answer.',
      steps: [
        { text: 'Earlier draft.', toolCalls: [] },
        { text: 'Final direct answer.', toolCalls: [] },
      ],
    }));
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead: vi.fn(), teams: [] });

    await expect(orchestrator.run({ message: message('hi') }))
      .resolves.toMatchObject({ body: 'Final direct answer.' });
  });

  it('removes delegateTeam after the first delegation so finalization can only return text', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async (_prompt: unknown, rawOptions: unknown) => {
      const options = rawOptions as {
        prepareStep(): Promise<{ activeTools: string[]; toolChoice: string }> | { activeTools: string[]; toolChoice: string };
      };
      await expect(options.prepareStep()).resolves.toEqual({
        activeTools: ['delegateTeam'],
        toolChoice: 'auto',
      });
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.'),
      });
      await expect(options.prepareStep()).resolves.toEqual({
        activeTools: [],
        toolChoice: 'none',
      });
      return { text: 'The checked evidence includes one account row.' };
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('List our accounts.') }))
      .resolves.toMatchObject({ body: 'The checked evidence includes one account row.' });
  });

  it('logs specialist completion timing without response content', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-orchestrator-'));
    const logging = configureLogging({ homeDirectory });
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.'),
      });
      return { text: 'Private checked answer body.' };
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    try {
      await orchestrator.run({ message: message('List our accounts.') });
      const agentLog = await readFile(join(homeDirectory, 'logs', 'agent.log'), 'utf8');
      expect(agentLog).toContain('orchestrator.delegate.completed');
      expect(agentLog).toContain('durationMs=');
      expect(agentLog).not.toContain('Private checked answer body.');
    } finally {
      logging.close();
    }
  });

  it('rejects a second delegateTeam call in one orchestrator turn', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, { team: 'query', request: queryDraft('List our accounts.') });
      await executeDelegate(orchestrator.agentTools.delegateTeam, { team: 'query', request: queryDraft('List our accounts.') });
      return { text: 'unreachable' };
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('List our accounts.') }))
      .rejects.toThrow('Only one specialist delegation is allowed per orchestrator turn.');
    expect(runTeamLead).toHaveBeenCalledTimes(1);
  });

  it('does not accept a direct draft after delegated work fails', async () => {
    const runTeamLead = vi.fn(async () => { throw new Error('team unavailable'); });
    const generate = vi.fn(async () => {
      try {
        await executeDelegate(orchestrator.agentTools.delegateTeam, {
          team: 'query',
          request: queryDraft('List our accounts.'),
        });
      } catch {
        return { text: 'Unchecked fallback' };
      }
      return { text: 'unreachable' };
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('List our accounts.') }))
      .rejects.toThrow('Delegated team');
  });

  it('does not recover to a direct draft after a second delegation is rejected', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.'),
      });
      try {
        await executeDelegate(orchestrator.agentTools.delegateTeam, {
          team: 'query',
          request: queryDraft('List our accounts.'),
        });
      } catch {
        return { text: 'Unchecked fallback' };
      }
      return { text: 'unreachable' };
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('List our accounts.') }))
      .rejects.toThrow('Delegated team work failed');
  });

  it('does not fall back to a checked result after the orchestrator signal aborts', async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.'),
      });
      entered();
      await new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    const turn = orchestrator.run({ message: message('List our accounts.'), signal: controller.signal });
    await enteredPromise;
    controller.abort(new DOMException('Timed out', 'TimeoutError'));

    await expect(turn).rejects.toThrow();
    expect(runTeamLead).toHaveBeenCalledOnce();
  });

  it('does not start delegated work after the orchestrator signal aborts', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('Timed out', 'TimeoutError'));
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.'),
      });
      return { text: 'unreachable' };
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('List our accounts.'), signal: controller.signal }))
      .rejects.toThrow('Timed out');
    expect(runTeamLead).not.toHaveBeenCalled();
  });

  it('does not let progress event failures fail delegated turns', async () => {
    const channelEvents = { emit: vi.fn(async () => { throw new Error('status transport unavailable'); }) };
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.', { desiredGrain: ['household', 'account'], coverage: ['account list'] }),
      });
      return { text: 'The checked evidence includes one account row.' };
    });
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(runTeamLead),
      channelEvents,
    });

    await expect(orchestrator.run({ message: message('List our accounts.') }))
      .resolves.toMatchObject({ body: expect.stringContaining('checked evidence') });
    expect(channelEvents.emit).toHaveBeenCalled();
    expect(runTeamLead).toHaveBeenCalledOnce();
  });

  it('keeps delegate context isolated across concurrent runs', async () => {
    const runTeamLead = vi.fn(async (input: Parameters<OrchestratorTeamRuntime['runTeamLead']>[0]) => {
      void input;
      return teamResult();
    });
    let secondDelegated!: () => void;
    const secondDelegatedPromise = new Promise<void>((resolve) => { secondDelegated = resolve; });
    let firstEntered!: () => void;
    const firstEnteredPromise = new Promise<void>((resolve) => { firstEntered = resolve; });
    const generate = vi.fn(async (prompt: unknown) => {
      const body = typeof prompt === 'string' && prompt.includes('first') ? 'first' : 'second';
      if (body === 'first') {
        firstEntered();
        await secondDelegatedPromise;
      } else {
        await firstEnteredPromise;
      }
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft(body),
      });
      if (body === 'second') secondDelegated();
      return { text: `${body} checked reply` };
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    await Promise.all([
      orchestrator.run({ message: message('first') }),
      orchestrator.run({ message: message('second') }),
    ]);

    expect(runTeamLead.mock.calls.map(([input]) => input.message.body).sort()).toEqual(['first', 'second']);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('returns a non-terminal turn result when a delegated team needs user clarification', async () => {
    const runTeamLead = vi.fn(async () => insufficientEvidenceResult());
    const generate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'accounting',
        request: {
          schemaName: 'accounting-lead-request',
          schemaVersion: 1,
          intent: 'transaction_capture',
          request: {
            schemaName: 'transaction-capture-request-draft',
            schemaVersion: 1,
            instruction: 'add $10 of buying a burger',
            known: { amount: '10.00', currency: 'USD' },
          },
        },
      });
      return { text: 'What currency should I use for this account?' };
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam, accountingTeam] });

    await expect(orchestrator.runTurn({ message: message('add $10 of buying a burger') })).resolves.toMatchObject({
      kind: 'ask-user',
      response: { body: 'What currency should I use for this account?' },
    });
  });

  it('uses only the checked question when post-delegation text leaks internal result fields', async () => {
    const runTeamLead = vi.fn(async () => insufficientEvidenceResult());
    const generate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'accounting',
        request: {
          schemaName: 'accounting-lead-request',
          schemaVersion: 1,
          intent: 'transaction_capture',
          request: {
            schemaName: 'transaction-capture-request-draft',
            schemaVersion: 1,
            instruction: 'add $10 of buying a burger',
            known: { amount: '10.00', currency: 'USD' },
          },
        },
      });
      return {
        text: [
          'Accounting team status: insufficient_evidence',
          'Checker accepted the result.',
          'What is its native currency?',
          'native_currency',
        ].join('\n\n'),
      };
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam, accountingTeam] });

    await expect(orchestrator.runTurn({ message: message('add $10 of buying a burger') }))
      .resolves.toMatchObject({
        kind: 'ask-user',
        response: { body: 'What is its native currency?' },
      });
  });

  it('uses checked team results instead of a direct answer when delegation is not verified', async () => {
    const runTeamLead = vi.fn(async () => failedTeamResult());
    const generate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('Show our transactions.'),
      });
      return { text: 'The query returned verified transactions.' };
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    const response = await orchestrator.run({ message: message('Show our transactions.') });

    expect(response.body).toBe('I could not complete that request safely. Please try again.');
    expect(response.body).not.toContain('Query team status: failed');
    expect(response.body).not.toContain('grain mismatch');
    expect(response.body).not.toContain('verified transactions');
    expect(response.citations).toEqual([{ label: 'query:team-result', sourceRef: 'team-result:failed' }]);
  });

  it('accepts delegated reply text and attaches checked team metadata', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.'),
      });
      return { text: 'not a typed final response' };
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('List our accounts.') }))
      .resolves.toMatchObject({
        body: 'not a typed final response',
        policyBoundary: 'personalized_finance',
        citations: [{ label: 'query:accounts-listed', artifactId }],
      });
  });

  it('renders a checked result when post-delegation text is empty', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.'),
      });
      return { text: '   ' };
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    const response = await orchestrator.run({ message: message('List our accounts.') });

    expect(response.body).toBe('I found the requested information, but I could not safely summarize it. Please try again.');
    expect(response.body).not.toContain('Ready for orchestrator reconciliation.');
    expect(response.citations).toEqual([{ label: 'query:accounts-listed', artifactId }]);
  });

  it('renders a checked result when post-delegation model finalization fails', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.'),
      });
      throw new Error('Inference capacity queue is full');
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('List our accounts.') }))
      .resolves.toMatchObject({
        body: 'I found the requested information, but I could not safely summarize it. Please try again.',
        citations: [{ label: 'query:accounts-listed', artifactId }],
      });
    expect(runTeamLead).toHaveBeenCalledOnce();
  });

  it('withholds opaque identifiers from an unsafe deterministic fallback while retaining checked citations', async () => {
    const unsafeResult = TeamResultEnvelopeSchemaV2.parse({
      ...teamResult(),
      claims: [
        ...teamResult().claims,
        {
          claimId: 'unsafe-draft-claim',
          text: `Use ${draftId} to continue.`,
          evidenceArtifactIds: [],
          checkedMakerArtifactIds: [artifactId],
        },
      ],
      completionReason: `The checked artifact is ${artifactId}.`,
      outstanding: [`Ask for ${draftId} if clarification is needed.`],
    });
    const runTeamLead = vi.fn(async () => unsafeResult);
    const generate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.'),
      });
      throw new Error('Inference capacity queue is full');
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    const response = await orchestrator.run({ message: message('List our accounts.') });

    expect(response.body).toBe('I found the requested information, but I could not safely summarize it. Please try again.');
    expect(response.body).not.toContain(draftId);
    expect(response.body).not.toContain(artifactId);
    expect(response.citations).toEqual(expect.arrayContaining([
      { label: 'query:accounts-listed', artifactId },
      { label: 'query:unsafe-draft-claim', artifactId },
    ]));
  });

  it('renders a checked result when post-delegation API retries exhaust as a Mastra result', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.'),
      });
      return { text: '', finishReason: 'retry' };
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('List our accounts.') }))
      .resolves.toMatchObject({
        body: 'I found the requested information, but I could not safely summarize it. Please try again.',
        citations: [{ label: 'query:accounts-listed', artifactId }],
      });
  });

  it('uses checked team citations for delegated reply text', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.', { desiredGrain: ['household', 'account'], coverage: ['account list'] }),
      });
      return { text: 'The Query team found one account.' };
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    const response = await orchestrator.run({ message: message('List our accounts.') });

    expect(response.citations).toEqual([{ label: 'query:accounts-listed', artifactId }]);
    expect(response.delivery.format).toBe('mrkdwn');
  });

  it('does not delegate when the orchestrator returns direct text', async () => {
    const runTeamLead = vi.fn();
    const generate = vi.fn(async () => ({ text: 'I can answer directly without a team.' }));
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam, accountingTeam] });

    const response = await orchestrator.run({ message: message('What can you do?') });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(runTeamLead).not.toHaveBeenCalled();
    expect(response.body).toBe('I can answer directly without a team.');
    expect(response.delivery.format).toBe('mrkdwn');
  });

  it('accepts ordinary no-team model text as a direct answer', async () => {
    const generate = vi.fn(async () => ({ text: 'I recorded it.' }));
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead: vi.fn(), teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('What can you do?') }))
      .resolves.toMatchObject({
        body: 'I recorded it.',
        policyBoundary: 'informational_only',
        citations: [{ label: 'orchestrator-policy', sourceRef: 'runtime-instructions' }],
      });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty direct model response', async () => {
    const generate = vi.fn(async () => ({ text: '   ' }));
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead: vi.fn(), teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('hello') }))
      .rejects.toThrow('empty response');
  });

  it('classifies an exhausted direct Mastra API retry result as transient', async () => {
    const generate = vi.fn(async () => ({ text: '', finishReason: 'retry' }));
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead: vi.fn(), teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('hello') }))
      .rejects.toMatchObject({ code: 'model_temporarily_unavailable', isRetryable: true });
  });

  it('rejects non-canonical delegate tool input before team execution', async () => {
    const runTeamLead = vi.fn();
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate: vi.fn() }) as never,
      teams: [queryTeam],
      teamRuntime: testTeamRuntime(runTeamLead),
    });

    const execute = orchestrator.agentTools.delegateTeam.execute as unknown as (input: unknown, options: unknown) => Promise<unknown>;
    await expect(execute({ team: 'Query Team', request: 'test' }, {})).resolves.toMatchObject({ error: true });
    await expect(execute({ team: 'query', request: '"test"' }, {})).resolves.toMatchObject({ error: true });
    expect(runTeamLead).not.toHaveBeenCalled();
  });

  it('withholds final text that asks the user for internal identifiers', async () => {
    const runTeamLead = vi.fn();
    const generate = vi.fn(async () => ({ text: 'Please send your Household ID and Book ID.' }));
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('Can you help?') }))
      .resolves.toMatchObject({ body: 'I could not prepare a safe response. Please try again.' });
  });

  it('withholds final model text that contains a contract opaque identifier', async () => {
    const generate = vi.fn(async () => ({ text: `Please use ${draftId} to continue.` }));
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead: vi.fn(), teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('Can you help?') }))
      .resolves.toMatchObject({ body: 'I could not prepare a safe response. Please try again.' });
  });
});

async function executeDelegate(
  tool: typeof OrchestratorAgent.prototype.agentTools.delegateTeam,
  input: { team: string; request: unknown },
): Promise<TeamResultEnvelopeV2> {
  const execute = tool.execute as unknown as (input: unknown, options: unknown) => Promise<unknown>;
  return TeamResultEnvelopeSchemaV2.parse(await execute(input, {}));
}
