import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TokenLimiter } from '@mastra/core/processors';
import {
  InboundChannelMessageSchemaV1,
  MakerArtifactSchemaV1,
  TeamResultEnvelopeSchemaV1,
  type TeamResultEnvelopeV1,
} from '@plus-one/contracts';
import { configureLogging, withLogContext, type TeamDefinition } from '@plus-one/runtime';
import { OrchestratorAgent } from '../src/agents/orchestrator.js';
import type { OrchestratorSessionMemoryPort } from '../src/memory/orchestrator-session-memory.js';
import type { OrchestratorTeamRuntime } from '../src/tools/delegate-team.js';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const conversationId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const taskId = 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const artifactId = 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K';
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
  return TeamResultEnvelopeSchemaV1.parse({
    schemaName: 'team-result',
    schemaVersion: 1,
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
  });
}

function insufficientEvidenceResult(team: 'accounting' | 'query' = 'accounting') {
  return TeamResultEnvelopeSchemaV1.parse({
    ...teamResult(team),
    status: 'insufficient_evidence',
    claims: [],
    completionReason: 'Need the payment account before recording this transaction.',
    outstanding: ['Which internal payment account should this use?'],
  });
}

function failedTeamResult() {
  return TeamResultEnvelopeSchemaV1.parse({
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
    teamRuntime: { runTeamLead: input.runTeamLead },
  });
}

describe('OrchestratorAgent', () => {
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
      teamRuntime: { runTeamLead: vi.fn() },
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
      teamRuntime: { runTeamLead: vi.fn() },
    });

    expect(orchestratorInstructions).toContain(
      'Account existence or account inventory questions use account list coverage.',
    );
    expect(orchestratorInstructions).toContain(
      'Use balance snapshot only when the user explicitly asks for a balance, amount, value, or net worth.',
    );
    expect(orchestratorInstructions).toContain(
      'An empty reporting.current_balances result does not prove that no accounts exist.',
    );
    expect(orchestratorInstructions).toContain(
      'Do not infer entity absence from an empty metric projection.',
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
      teamRuntime: { runTeamLead: vi.fn() },
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

  it('answers a direct message as text with one two-step-bounded orchestrator generation', async () => {
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
      teamRuntime: { runTeamLead: vi.fn() },
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
    expect(stopWhen({ steps: [{ finishReason: 'tool-calls' }, { finishReason: 'stop' }] })).toBe(true);
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
      teamRuntime: { runTeamLead },
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

  it('falls back to checked team text when the post-tool step has no final body', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query', request: queryDraft('List our accounts.', { coverage: ['account list'] }),
      });
      return {
        text: 'Preamble that must never be a final response.',
        steps: [
          { text: 'Preamble that must never be a final response.', toolCalls: [{ toolName: 'delegateTeam' }] },
          { text: '', toolCalls: [] },
        ],
      };
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    const response = await orchestrator.run({ message: message('List our accounts.') });

    expect(response.body).toContain('The checked evidence includes one account row.');
    expect(response.body).not.toContain('Preamble that must never be a final response.');
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
      teamRuntime: { runTeamLead },
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
      return { text: 'The accounting team needs clarification before posting.' };
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam, accountingTeam] });

    await expect(orchestrator.runTurn({ message: message('add $10 of buying a burger') })).resolves.toMatchObject({
      kind: 'ask-user',
      response: { body: expect.stringContaining('Which internal payment account should this use?') },
    });
  });

  it('uses checked clarification instead of unrelated post-delegation text', async () => {
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
      return { text: 'not a typed final response' };
    });
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam, accountingTeam] });

    await expect(orchestrator.runTurn({ message: message('add $10 of buying a burger') }))
      .resolves.toMatchObject({
        kind: 'ask-user',
        response: { body: expect.stringContaining('Which internal payment account should this use?') },
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

    expect(response.body).toContain('Query team status: failed');
    expect(response.body).toContain('grain mismatch');
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

    expect(response.body).toContain('The checked evidence includes one account row.');
    expect(response.body).toContain('Ready for orchestrator reconciliation.');
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
        body: expect.stringContaining('The checked evidence includes one account row.'),
        citations: [{ label: 'query:accounts-listed', artifactId }],
      });
    expect(runTeamLead).toHaveBeenCalledOnce();
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
        body: expect.stringContaining('The checked evidence includes one account row.'),
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
      teamRuntime: { runTeamLead },
    });

    const execute = orchestrator.agentTools.delegateTeam.execute as unknown as (input: unknown, options: unknown) => Promise<unknown>;
    await expect(execute({ team: 'Query Team', request: 'test' }, {})).resolves.toMatchObject({ error: true });
    await expect(execute({ team: 'query', request: '"test"' }, {})).resolves.toMatchObject({ error: true });
    expect(runTeamLead).not.toHaveBeenCalled();
  });

  it('rejects final text that asks the user for internal identifiers', async () => {
    const runTeamLead = vi.fn();
    const generate = vi.fn(async () => ({ text: 'Please send your Household ID and Book ID.' }));
    const orchestrator = singleLoopOrchestrator({ generate, runTeamLead, teams: [queryTeam] });

    await expect(orchestrator.run({ message: message('Can you help?') }))
      .rejects.toThrow('internal identifier request');
  });
});

async function executeDelegate(
  tool: typeof OrchestratorAgent.prototype.agentTools.delegateTeam,
  input: { team: string; request: unknown },
): Promise<TeamResultEnvelopeV1> {
  const execute = tool.execute as unknown as (input: unknown, options: unknown) => Promise<unknown>;
  return TeamResultEnvelopeSchemaV1.parse(await execute(input, {}));
}
