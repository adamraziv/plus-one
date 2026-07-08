import { describe, expect, it, vi } from 'vitest';
import { TokenLimiter } from '@mastra/core/processors';
import {
  InboundChannelMessageSchemaV1,
  MakerArtifactSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  TeamResultEnvelopeSchemaV1,
  type OrchestratorFinalResponseV1,
  type TeamResultEnvelopeV1,
} from '@plus-one/contracts';
import type { TeamDefinition } from '@plus-one/runtime';
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

function teamResult() {
  return TeamResultEnvelopeSchemaV1.parse({
    schemaName: 'team-result',
    schemaVersion: 1,
    householdId,
    taskId,
    team: 'query',
    status: 'verified',
    claims: [{
      claimId: 'accounts-listed',
      text: 'The checked evidence includes one account row.',
      evidenceArtifactIds: [],
      checkedMakerArtifactIds: [artifactId],
    }],
    assumptions: [],
    uncertainty: [],
    freshness: [`query refreshed ${now}`],
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
    ...teamResult(),
    team,
    status: 'insufficient_evidence',
    claims: [],
    completionReason: 'Need the payment account before recording this transaction.',
    outstanding: ['Which internal payment account should this use?'],
  });
}

function finalResponse(body = 'Structured response.'): OrchestratorFinalResponseV1 {
  return OrchestratorFinalResponseSchemaV1.parse({
    schemaName: 'orchestrator-final-response',
    schemaVersion: 1,
    responseId: 'response-structured',
    householdId,
    conversationId,
    body,
    policyBoundary: 'informational_only',
    citations: [{ label: 'orchestrator-policy', sourceRef: 'runtime-instructions' }],
    assumptions: [],
    freshness: ['current invocation only'],
    disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
    unsupportedCapabilities: [],
    recommendationActions: [],
    delivery: { channel: 'telegram', destination: { chatId: 'telegram-chat-42' }, format: 'plain_text' },
    responseHash: 'd'.repeat(64),
    createdAt: now,
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

describe('OrchestratorAgent', () => {
  it('limits only the top-level orchestrator input context', () => {
    const configs: Array<{ id?: string; inputProcessors?: unknown }> = [];

    new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => {
        configs.push(config);
        return { ...config, generate: vi.fn() } as never;
      },
      teams: [queryTeam],
      teamRuntime: { runTeamLead: vi.fn() },
    });

    const byId = Object.fromEntries(configs.map((config) => [config.id, config]));
    const inputProcessors = byId.orchestrator?.inputProcessors;

    expect(Array.isArray(inputProcessors)).toBe(true);
    if (!Array.isArray(inputProcessors)) throw new Error('Expected orchestrator input processors.');
    expect(inputProcessors).toHaveLength(1);
    expect(inputProcessors[0]).toBeInstanceOf(TokenLimiter);
    expect(inputProcessors[0]).toMatchObject({ id: 'token-limiter' });
    expect((inputProcessors[0] as TokenLimiter).getMaxTokens()).toBe(24_000);
    expect(byId['orchestrator-accounting-intent']?.inputProcessors).toBeUndefined();
    expect(byId['orchestrator-query-intent']?.inputProcessors).toBeUndefined();
    expect(byId['orchestrator-finalizer']?.inputProcessors).toBeUndefined();
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
    const mainGenerate = vi.fn(async (messages) => {
      expect(messages).toEqual([
        expect.objectContaining({ role: 'assistant' }),
        expect.objectContaining({ role: 'user' }),
      ]);
      return { text: 'raw reasoning answer' };
    });
    const accountingIntentGenerate = vi.fn(async () => ({
      object: { shouldDelegateTransactionCapture: false, known: {} },
    }));
    const queryIntentGenerate = vi.fn(async () => ({
      object: { shouldDelegateQuery: false, desiredGrain: [], requiredCalculations: [], coverage: [] },
    }));
    const finalizerGenerate = vi.fn(async () => ({
      object: {
        body: 'Final clean answer.',
        policyBoundary: 'informational_only',
        citations: [{ label: 'orchestrator-policy', sourceRef: 'runtime-instructions' }],
        assumptions: [],
        freshness: ['current invocation only'],
        disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
        unsupportedCapabilities: [],
        recommendationActions: [],
      },
    }));
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => {
        if (config.id === 'orchestrator-accounting-intent') {
          return { ...config, generate: accountingIntentGenerate } as never;
        }
        if (config.id === 'orchestrator-query-intent') {
          return { ...config, generate: queryIntentGenerate } as never;
        }
        return {
          ...config,
          generate: Object.keys((config.tools as Record<string, unknown> | undefined) ?? {}).length === 0
            ? finalizerGenerate
            : mainGenerate,
        } as never;
      },
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

  it('passes prior transcript context into accounting intent classification on a follow-up turn', async () => {
    const sessionMemory: OrchestratorSessionMemoryPort = {
      prepareInput: vi.fn(async () => [
        memoryMessage('user', 'I spent 10 USD on groceries.'),
        memoryMessage('assistant', 'Which internal payment account should this use?'),
        memoryMessage('user', 'Use my checking account and the purchase was today.'),
      ]),
      persistTurn: vi.fn(),
      close: vi.fn(),
    };
    const runTeamLead = vi.fn(async () => insufficientEvidenceResult());
    const mainGenerate = vi.fn(async () => ({
      text: 'Need more accounting details.',
    }));
    const accountingIntentGenerate = vi.fn(async (prompt: string) => {
      expect(prompt).toContain('Conversation transcript before the latest inbound message:');
      expect(prompt).toContain('Latest inbound message JSON:');
      expect(prompt).toContain('When the latest user message answers a prior clarification, merge it with earlier user-stated transaction details from the same conversation.');
      expect(prompt).toContain('I spent 10 USD on groceries.');
      expect(prompt).toContain('Use my checking account and the purchase was today.');
      return {
        object: {
          shouldDelegateTransactionCapture: true,
          shouldDelegateJournal: false,
          instruction: 'I spent 10 USD on groceries.',
          known: {
            amount: '10.00',
            currency: 'USD',
            paymentAccountName: 'checking',
            occurredOn: '2026-06-23',
            categoryName: 'groceries',
          },
        },
      };
    });
    const queryIntentGenerate = vi.fn(async () => ({
      object: { shouldDelegateQuery: false, desiredGrain: [], requiredCalculations: [], coverage: [] },
    }));
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => {
        if (config.id === 'orchestrator-accounting-intent') {
          return { ...config, generate: accountingIntentGenerate } as never;
        }
        if (config.id === 'orchestrator-query-intent') {
          return { ...config, generate: queryIntentGenerate } as never;
        }
        return { ...config, generate: mainGenerate } as never;
      },
      sessionMemory,
      teams: [accountingTeam],
      teamRuntime: { runTeamLead },
    });

    const response = await orchestrator.run({
      message: message('Use my checking account and the purchase was today.'),
    });

    expect(accountingIntentGenerate).toHaveBeenCalledTimes(1);
    expect(queryIntentGenerate).not.toHaveBeenCalled();
    expect(runTeamLead).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({ body: 'Use my checking account and the purchase was today.' }),
      team: accountingTeam,
      request: expect.objectContaining({
        intent: 'transaction_capture',
        request: expect.objectContaining({
          instruction: 'I spent 10 USD on groceries.',
          known: expect.objectContaining({
            amount: '10.00',
            currency: 'USD',
          }),
        }),
      }),
    }));
    expect(response.body).toContain('Which internal payment account should this use?');
  });

  it('lets the orchestrator agent delegate through the existing team lead runtime', async () => {
    const channelEvents = { emit: vi.fn(async () => undefined) };
    const inbound = message('List our accounts.');
    const runTeamLead = vi.fn(async (input) => {
      expect(input.request).toMatchObject({ businessQuestion: 'List our accounts.' });
      return teamResult();
    });
    const generate = vi.fn(async (messages) => {
      expect(messages).toContain('List our accounts.');
      const result = await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.', {
          desiredGrain: ['household', 'account'],
          coverage: ['account list'],
        }),
      });
      return {
        object: OrchestratorFinalResponseSchemaV1.parse({
          schemaName: 'orchestrator-final-response',
          schemaVersion: 1,
          responseId: 'response-1',
          householdId,
          conversationId,
          body: result.claims[0]!.text + '\n\nPlus One is an AI assistant, not a licensed financial professional.',
          policyBoundary: 'personalized_finance',
          citations: [{ label: 'query:accounts-listed', artifactId }],
          assumptions: [],
          freshness: result.freshness,
          disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
          unsupportedCapabilities: [],
          recommendationActions: [],
          delivery: { channel: 'telegram', destination: { chatId: 'telegram-chat-42' }, format: 'plain_text' },
          responseHash: 'c'.repeat(64),
          createdAt: now,
        }),
      };
    });
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      teams: [queryTeam],
      teamRuntime: { runTeamLead },
      channelEvents,
    });

    const response = await orchestrator.run({ message: inbound });

    expect(runTeamLead).toHaveBeenCalledWith(expect.objectContaining({ team: queryTeam }));
    expect(channelEvents.emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'tool.started',
      toolName: 'delegateTeam',
      target: expect.objectContaining({
        conversationId,
        destination: { chatId: 'telegram-chat-42' },
      }),
    }));
    expect(channelEvents.emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'tool.finished',
      toolName: 'delegateTeam',
      ok: true,
    }));
    expect(generate).toHaveBeenCalledTimes(1);
    expect((orchestrator.agent as unknown as { description: string }).description).toContain('single entrypoint');
    expect(orchestrator.agentTools.delegateTeam.description).toContain('specialist team lead');
    expect(response.body).toContain('one account row');
    expect(response.body).not.toContain('Delegating to query');
    expect(inbound.metadata).toEqual({ destination: { chatId: 'telegram-chat-42' } });
  });

  it('does not let progress event failures fail delegated turns', async () => {
    const channelEvents = {
      emit: vi.fn(async () => {
        throw new Error('status transport unavailable');
      }),
    };
    const runTeamLead = vi.fn(async () => teamResult());
    const generate = vi.fn(async () => {
      const result = await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.', {
          desiredGrain: ['household', 'account'],
          coverage: ['account list'],
        }),
      });
      return {
        object: OrchestratorFinalResponseSchemaV1.parse({
          schemaName: 'orchestrator-final-response',
          schemaVersion: 1,
          responseId: 'response-1',
          householdId,
          conversationId,
          body: result.claims[0]!.text + '\n\nPlus One is an AI assistant, not a licensed financial professional.',
          policyBoundary: 'personalized_finance',
          citations: [{ label: 'query:accounts-listed', artifactId }],
          assumptions: [],
          freshness: result.freshness,
          disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
          unsupportedCapabilities: [],
          recommendationActions: [],
          delivery: { channel: 'telegram', destination: { chatId: 'telegram-chat-42' }, format: 'plain_text' },
          responseHash: 'c'.repeat(64),
          createdAt: now,
        }),
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
      .resolves.toMatchObject({ body: expect.stringContaining('one account row') });
    expect(channelEvents.emit).toHaveBeenCalled();
    expect(runTeamLead).toHaveBeenCalledOnce();
  });

  it('keeps delegate context isolated across concurrent runs', async () => {
    const runTeamLead = vi.fn(async (_input: Parameters<OrchestratorTeamRuntime['runTeamLead']>[0]) => {
      void _input;
      return teamResult();
    });
    let secondDelegated!: () => void;
    const secondDelegatedPromise = new Promise<void>((resolve) => {
      secondDelegated = resolve;
    });
    let firstEntered!: () => void;
    const firstEnteredPromise = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const mainGenerate = vi.fn(async (messages: string) => {
      const body = messages.includes('first') ? 'first' : 'second';
      if (body === 'first') {
        firstEntered();
        await secondDelegatedPromise;
      } else {
        await firstEnteredPromise;
      }
      const result = await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft(body),
      });
      if (body === 'second') secondDelegated();
      return {
        object: OrchestratorFinalResponseSchemaV1.parse({
          schemaName: 'orchestrator-final-response',
          schemaVersion: 1,
          responseId: `response-${body}`,
          householdId,
          conversationId,
          body: result.claims[0]!.text + '\n\nPlus One is an AI assistant, not a licensed financial professional.',
          policyBoundary: 'personalized_finance',
          citations: [{ label: 'query:accounts-listed', artifactId }],
          assumptions: [],
          freshness: result.freshness,
          disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
          unsupportedCapabilities: [],
          recommendationActions: [],
          delivery: { channel: 'telegram', destination: { chatId: 'telegram-chat-42' }, format: 'plain_text' },
          responseHash: 'c'.repeat(64),
          createdAt: now,
        }),
      };
    });
    const accountingIntentGenerate = vi.fn(async () => ({
      object: { shouldDelegateTransactionCapture: false, known: {} },
    }));
    const queryIntentGenerate = vi.fn(async () => ({
      object: { shouldDelegateQuery: false, desiredGrain: [], requiredCalculations: [], coverage: [] },
    }));
    const finalizerGenerate = vi.fn();
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => {
        if (config.id === 'orchestrator-accounting-intent') {
          return { ...config, generate: accountingIntentGenerate } as never;
        }
        if (config.id === 'orchestrator-query-intent') {
          return { ...config, generate: queryIntentGenerate } as never;
        }
        return {
          ...config,
          generate: Object.keys((config.tools as Record<string, unknown> | undefined) ?? {}).length === 0
            ? finalizerGenerate
            : mainGenerate,
        } as never;
      },
      teams: [queryTeam],
      teamRuntime: { runTeamLead },
    });

    await Promise.all([
      orchestrator.run({ message: message('first') }),
      orchestrator.run({ message: message('second') }),
    ]);

    expect(runTeamLead.mock.calls.map(([input]) => input.message.body).sort())
      .toEqual(['first', 'second']);
    expect(accountingIntentGenerate).not.toHaveBeenCalled();
    expect(queryIntentGenerate).toHaveBeenCalledTimes(2);
    expect(finalizerGenerate).not.toHaveBeenCalled();
  });

  it('keeps final schema off the reasoning agent and uses a no-tools finalizer', async () => {
    const mainGenerate = vi.fn(async (_messages: unknown, options: Record<string, unknown>) => {
      expect(options).toEqual({
        memory: {
          thread: conversationId,
          resource: householdId,
        },
      });
      return { text: 'Plus One can help with household finance questions.' };
    });
    const accountingIntentGenerate = vi.fn(async (_messages: unknown, options: Record<string, unknown>) => {
      expect(options).toMatchObject({
        toolChoice: 'none',
      });
      return { object: { shouldDelegateTransactionCapture: false, known: {} } };
    });
    const queryIntentGenerate = vi.fn();
    const finalizerGenerate = vi.fn(async (_messages: unknown, options: Record<string, unknown>) => {
      expect(options).toMatchObject({
        structuredOutput: expect.objectContaining({ jsonPromptInjection: true }),
        toolChoice: 'none',
      });
      return {
        object: {
          body: 'Plus One can help with household finance questions.',
          policyBoundary: 'informational_only',
          citations: [{ label: 'orchestrator-policy', sourceRef: 'runtime-instructions' }],
          assumptions: [],
          freshness: ['current invocation only'],
          disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
          unsupportedCapabilities: [],
          recommendationActions: [],
        },
      };
    });
    const configs: Array<{ id?: string; tools: Record<string, unknown> | undefined }> = [];
    const orchestrator = new OrchestratorAgent({
      model: { id: 'deepseek/deepseek-v4-flash', endpoint: 'https://api.deepseek.com', apiKey: 'test-api-key' },
      agentFactory: (config) => {
        configs.push({ id: config.id, tools: config.tools as Record<string, unknown> | undefined });
        if (config.id === 'orchestrator-accounting-intent') {
          return { ...config, generate: accountingIntentGenerate } as never;
        }
        if (config.id === 'orchestrator-query-intent') {
          return { ...config, generate: queryIntentGenerate } as never;
        }
        return {
          ...config,
          generate: Object.keys((config.tools as Record<string, unknown> | undefined) ?? {}).length === 0
            ? finalizerGenerate
            : mainGenerate,
        } as never;
      },
      teams: [queryTeam],
      teamRuntime: { runTeamLead: vi.fn() },
    });

    await expect(orchestrator.run({ message: message('What can you do?') }))
      .resolves.toMatchObject({ body: 'Plus One can help with household finance questions.' });
    expect(mainGenerate).toHaveBeenCalledTimes(1);
    expect(accountingIntentGenerate).toHaveBeenCalledTimes(1);
    expect(queryIntentGenerate).toHaveBeenCalledTimes(1);
    expect(finalizerGenerate).toHaveBeenCalledTimes(1);
    expect(configs).toEqual([
      expect.objectContaining({ id: 'orchestrator', tools: expect.any(Object) }),
      expect.objectContaining({ id: 'orchestrator-accounting-intent', tools: {} }),
      expect.objectContaining({ id: 'orchestrator-query-intent', tools: {} }),
      expect.objectContaining({ id: 'orchestrator-finalizer', tools: {} }),
    ]);
  });

  it('returns a non-terminal turn result when a delegated team needs user clarification', async () => {
    const runTeamLead = vi.fn(async () => insufficientEvidenceResult());
    const mainGenerate = vi.fn(async () => {
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
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate: mainGenerate }) as never,
      teams: [queryTeam, accountingTeam],
      teamRuntime: { runTeamLead },
    });

    const result = await (orchestrator as OrchestratorAgent & {
      runTurn: (input: { message: ReturnType<typeof message> }) => Promise<unknown>;
    }).runTurn({ message: message('add $10 of buying a burger') });

    expect(result).toMatchObject({
      kind: 'ask-user',
      response: {
        body: expect.stringContaining('Which internal payment account should this use?'),
      },
    });
  });

  it('uses checked team results when a reasoning model returns prose plus fenced JSON after delegation', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const mainGenerate = vi.fn(async () => {
      const result = await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.', {
          desiredGrain: ['household', 'account'],
          coverage: ['account list'],
        }),
      });
      return {
        text: [
          'Here is the answer.',
          '```json',
          JSON.stringify(finalResponse(result.claims[0]!.text)),
          '```',
        ].join('\n'),
      };
    });
    const finalizerGenerate = vi.fn(async () => ({ text: 'still not structured' }));
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({
        ...config,
        generate: Object.keys((config.tools as Record<string, unknown> | undefined) ?? {}).length === 0
          ? finalizerGenerate
          : mainGenerate,
      }) as never,
      teams: [queryTeam],
      teamRuntime: { runTeamLead },
    });

    const response = await orchestrator.run({ message: message('List our accounts.') });

    expect(mainGenerate).toHaveBeenCalledTimes(1);
    expect(finalizerGenerate).toHaveBeenCalledTimes(1);
    expect(runTeamLead).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      schemaName: 'orchestrator-final-response',
      body: expect.stringContaining('Ready for orchestrator reconciliation.'),
      citations: [{ label: 'query:accounts-listed', artifactId }],
    });
  });

  it('uses checked team citations when the finalizer omits citations after delegation', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const mainGenerate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.', {
          desiredGrain: ['household', 'account'],
          coverage: ['account list'],
        }),
      });
      return { text: 'The Query team found one account.' };
    });
    const finalizerGenerate = vi.fn(async () => ({
      object: {
        body: 'The Query team found one account.',
        policyBoundary: 'personalized_finance',
        citations: [],
        assumptions: [],
        freshness: ['current invocation only'],
        disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
        unsupportedCapabilities: [],
        recommendationActions: [],
      },
    }));
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({
        ...config,
        generate: Object.keys((config.tools as Record<string, unknown> | undefined) ?? {}).length === 0
          ? finalizerGenerate
          : mainGenerate,
      }) as never,
      teams: [queryTeam],
      teamRuntime: { runTeamLead },
    });

    const response = await orchestrator.run({ message: message('List our accounts.') });

    expect(runTeamLead).toHaveBeenCalledTimes(1);
    expect(finalizerGenerate).toHaveBeenCalledTimes(1);
    expect(response.citations).toEqual([{ label: 'query:accounts-listed', artifactId }]);
    expect(response.delivery.format).toBe('mrkdwn');
  });

  it('does not let the finalizer rewrite failed team results as successful answers', async () => {
    const failedResult = TeamResultEnvelopeSchemaV1.parse({
      ...teamResult(),
      status: 'failed',
      claims: [],
      makerArtifacts: [],
      checkerVerdicts: [],
      freshness: [],
      completionReason: 'The checker rejected the artifact or revision attempts were exhausted.',
      outstanding: ['grain mismatch'],
    });
    const runTeamLead = vi.fn(async () => failedResult);
    const mainGenerate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('Show our transactions.'),
      });
      return { text: 'The query returned verified transactions.' };
    });
    const finalizerGenerate = vi.fn(async () => ({
      object: {
        body: 'The query returned verified transactions.',
        policyBoundary: 'personalized_finance',
        citations: [],
        assumptions: [],
        freshness: ['current invocation only'],
        disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
        unsupportedCapabilities: [],
        recommendationActions: [],
      },
    }));
    const queryIntentGenerate = vi.fn(async () => ({
      object: { shouldDelegateQuery: false, desiredGrain: [], requiredCalculations: [], coverage: [] },
    }));
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => {
        if (config.id === 'orchestrator-query-intent') {
          return { ...config, generate: queryIntentGenerate } as never;
        }
        return {
          ...config,
          generate: Object.keys((config.tools as Record<string, unknown> | undefined) ?? {}).length === 0
            ? finalizerGenerate
            : mainGenerate,
        } as never;
      },
      teams: [queryTeam],
      teamRuntime: { runTeamLead },
    });

    const response = await orchestrator.run({ message: message('Show our transactions.') });

    expect(finalizerGenerate).not.toHaveBeenCalled();
    expect(queryIntentGenerate).toHaveBeenCalledTimes(1);
    expect(response.body).toContain('Query team status: failed');
    expect(response.body).toContain('grain mismatch');
    expect(response.body).not.toContain('verified transactions');
    expect(response.citations).toEqual([{ label: 'query:team-result', sourceRef: 'team-result:failed' }]);
    expect(response.delivery.format).toBe('mrkdwn');
  });

  it('uses a later verified team result over an earlier failed retry result', async () => {
    const failedResult = TeamResultEnvelopeSchemaV1.parse({
      ...teamResult(),
      status: 'failed',
      claims: [],
      makerArtifacts: [],
      checkerVerdicts: [],
      freshness: [],
      completionReason: 'Agent output failed structured validation',
      outstanding: ['agent_output_schema_failed'],
    });
    const verifiedResult = teamResult();
    const runTeamLead = vi.fn()
      .mockResolvedValueOnce(failedResult)
      .mockResolvedValueOnce(verifiedResult);
    const mainGenerate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.', {
          desiredGrain: ['household', 'account'],
          coverage: ['account list'],
        }),
      });
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: queryDraft('List our accounts.', {
          desiredGrain: ['household', 'account'],
          coverage: ['account list'],
        }),
      });
      return { text: 'The Query team found one account.' };
    });
    const finalizerGenerate = vi.fn();
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({
        ...config,
        generate: Object.keys((config.tools as Record<string, unknown> | undefined) ?? {}).length === 0
          ? finalizerGenerate
          : mainGenerate,
      }) as never,
      teams: [queryTeam],
      teamRuntime: { runTeamLead },
    });

    const response = await orchestrator.run({ message: message('List our accounts.') });

    expect(runTeamLead).toHaveBeenCalledTimes(2);
    expect(finalizerGenerate).not.toHaveBeenCalled();
    expect(response.body).toContain('Query team status: verified');
    expect(response.body).not.toContain('agent_output_schema_failed');
    expect(response.citations).toEqual([{ label: 'query:accounts-listed', artifactId }]);
  });

  it('does not synthesize query delegation when the model returns a direct final response', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const mainGenerate = vi.fn(async () => ({
      object: finalResponse('I can answer directly without a team.'),
    }));
    const accountingIntentGenerate = vi.fn(async () => ({
      object: { shouldDelegateTransactionCapture: false, known: {} },
    }));
    const queryIntentGenerate = vi.fn(async () => ({
      object: { shouldDelegateQuery: false, desiredGrain: [], requiredCalculations: [], coverage: [] },
    }));
    const finalizerGenerate = vi.fn();
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => {
        if (config.id === 'orchestrator-accounting-intent') {
          return { ...config, generate: accountingIntentGenerate } as never;
        }
        if (config.id === 'orchestrator-query-intent') {
          return { ...config, generate: queryIntentGenerate } as never;
        }
        return {
          ...config,
          generate: Object.keys((config.tools as Record<string, unknown> | undefined) ?? {}).length === 0
            ? finalizerGenerate
            : mainGenerate,
        } as never;
      },
      teams: [queryTeam, accountingTeam],
      teamRuntime: { runTeamLead },
    });

    const response = await orchestrator.run({ message: message('List our accounts.') });

    expect(mainGenerate).toHaveBeenCalledTimes(1);
    expect(accountingIntentGenerate).toHaveBeenCalledTimes(1);
    expect(queryIntentGenerate).toHaveBeenCalledTimes(1);
    expect(finalizerGenerate).not.toHaveBeenCalled();
    expect(runTeamLead).not.toHaveBeenCalled();
    expect(response.body).toBe('I can answer directly without a team.');
    expect(response.delivery.format).toBe('mrkdwn');
  });

  it('delegates internal finance reads when the reasoning model answers without checked data', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const mainGenerate = vi.fn(async () => ({
      object: finalResponse('I currently do not have access to your transaction history.'),
    }));
    const accountingIntentGenerate = vi.fn(async () => ({
      object: { shouldDelegateTransactionCapture: false, known: {} },
    }));
    const queryIntentGenerate = vi.fn(async (_messages: unknown, options: Record<string, unknown>) => {
      expect(options).toMatchObject({
        toolChoice: 'none',
      });
      return {
        object: {
          shouldDelegateQuery: true,
          businessQuestion: 'What are my top expenses this month?',
          timeframe: { start: '2026-06-01', end: '2026-06-30' },
          desiredGrain: ['household', 'month', 'category'],
          requiredCalculations: [],
          coverage: ['category spend monthly'],
        },
      };
    });
    const finalizerGenerate = vi.fn(async () => ({
      object: {
        body: 'Your checked expense data is ready.',
        policyBoundary: 'personalized_finance',
        citations: [],
        assumptions: [],
        freshness: ['current invocation only'],
        disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
        unsupportedCapabilities: [],
        recommendationActions: [],
      },
    }));
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => {
        if (config.id === 'orchestrator-accounting-intent') {
          return { ...config, generate: accountingIntentGenerate } as never;
        }
        if (config.id === 'orchestrator-query-intent') {
          return { ...config, generate: queryIntentGenerate } as never;
        }
        return {
          ...config,
          generate: Object.keys((config.tools as Record<string, unknown> | undefined) ?? {}).length === 0
            ? finalizerGenerate
            : mainGenerate,
        } as never;
      },
      teams: [queryTeam, accountingTeam],
      teamRuntime: { runTeamLead },
    });

    const response = await orchestrator.run({
      message: message('What are my top expenses this month?'),
    });

    expect(queryIntentGenerate).toHaveBeenCalledTimes(1);
    expect(accountingIntentGenerate).toHaveBeenCalledTimes(1);
    expect(runTeamLead).toHaveBeenCalledWith(expect.objectContaining({
      team: queryTeam,
      request: expect.objectContaining({
        schemaName: 'query-lead-request-draft',
        businessQuestion: 'What are my top expenses this month?',
        desiredGrain: ['household', 'month', 'category'],
        requiredCalculations: [],
        coverage: ['category spend monthly'],
      }),
    }));
    expect(finalizerGenerate).toHaveBeenCalledTimes(1);
    expect(response.body).toBe('Your checked expense data is ready.');
  });

  it('refines bare query delegations before they reach the query team', async () => {
    const runTeamLead = vi.fn(async () => teamResult());
    const mainGenerate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'query',
        request: {
          schemaName: 'query-lead-request-draft',
          schemaVersion: 1,
          businessQuestion: 'What is my current bank account balance?',
          requiredCalculations: [],
        },
      });
      return { text: 'The query team found checked balance evidence.' };
    });
    const queryIntentGenerate = vi.fn(async () => ({
      object: {
        shouldDelegateQuery: true,
        businessQuestion: 'What is my current bank account balance?',
        desiredGrain: ['household', 'account'],
        requiredCalculations: [],
        coverage: ['balance snapshot'],
      },
    }));
    const finalizerGenerate = vi.fn(async () => ({
      object: {
        body: 'Your checked balance data is ready.',
        policyBoundary: 'personalized_finance',
        citations: [],
        assumptions: [],
        freshness: ['current invocation only'],
        disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
        unsupportedCapabilities: [],
        recommendationActions: [],
      },
    }));
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => {
        if (config.id === 'orchestrator-query-intent') {
          return { ...config, generate: queryIntentGenerate } as never;
        }
        return {
          ...config,
          generate: Object.keys((config.tools as Record<string, unknown> | undefined) ?? {}).length === 0
            ? finalizerGenerate
            : mainGenerate,
        } as never;
      },
      teams: [queryTeam, accountingTeam],
      teamRuntime: { runTeamLead },
    });

    const response = await orchestrator.run({
      message: message('What is my current bank account balance?'),
    });

    expect(queryIntentGenerate).toHaveBeenCalledTimes(1);
    expect(runTeamLead).toHaveBeenCalledWith(expect.objectContaining({
      team: queryTeam,
      request: expect.objectContaining({
        businessQuestion: 'What is my current bank account balance?',
        desiredGrain: ['household', 'account'],
        coverage: ['balance snapshot'],
      }),
    }));
    expect(response.body).toBe('Your checked balance data is ready.');
  });

  it('uses the Mastra delegate tool for accounting writes instead of regex pre-routing', async () => {
    const runTeamLead = vi.fn(async () => insufficientEvidenceResult());
    const mainGenerate = vi.fn(async () => {
      await executeDelegate(orchestrator.agentTools.delegateTeam, {
        team: 'accounting',
        request: {
          schemaName: 'accounting-lead-request',
          schemaVersion: 1,
          intent: 'transaction_capture',
          request: {
            schemaName: 'transaction-capture-request-draft',
            schemaVersion: 1,
            instruction: 'Record a USD 10.00 burger purchase from checking on 2026-06-27 in dining out.',
            known: {
              amount: '10.00',
              currency: 'USD',
              occurredOn: '2026-06-27',
              paymentAccountName: 'checking',
              categoryName: 'dining out',
            },
          },
        },
      });
      return { text: 'The accounting team needs clarification before posting.' };
    });
    const finalizerGenerate = vi.fn();
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({
        ...config,
        generate: Object.keys((config.tools as Record<string, unknown> | undefined) ?? {}).length === 0
          ? finalizerGenerate
          : mainGenerate,
      }) as never,
      teams: [queryTeam, accountingTeam],
      teamRuntime: { runTeamLead },
    });

    const result = await orchestrator.runTurn({
      message: message('Record a USD 10.00 burger purchase from checking on 2026-06-27 in dining out.'),
    });

    expect(mainGenerate).toHaveBeenCalledTimes(1);
    expect(finalizerGenerate).not.toHaveBeenCalled();
    expect(runTeamLead).toHaveBeenCalledWith(expect.objectContaining({
      team: accountingTeam,
      request: expect.objectContaining({
        schemaName: 'accounting-lead-request',
        schemaVersion: 1,
        intent: 'transaction_capture',
      }),
    }));
    expect(result).toMatchObject({
      kind: 'ask-user',
      response: {
        body: expect.stringContaining('Which internal payment account should this use?'),
      },
    });
  });

  it('uses structured intent classification when the reasoning model answers directly without delegating', async () => {
    const runTeamLead = vi.fn(async () => insufficientEvidenceResult());
    const mainGenerate = vi.fn(async () => ({ text: 'Transaction recorded.' }));
    const accountingIntentGenerate = vi.fn(async (_messages: unknown, options: Record<string, unknown>) => {
      expect(options).toMatchObject({
        toolChoice: 'none',
      });
      return {
        object: {
          shouldDelegateTransactionCapture: true,
          instruction: 'Record a USD 10.00 burger purchase from checking on 2026-06-27 in dining out.',
          known: {
            amount: '10.00',
            currency: 'USD',
            occurredOn: '2026-06-27',
            paymentAccountName: 'checking',
            categoryName: 'dining out',
          },
        },
      };
    });
    const finalizerGenerate = vi.fn();
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => {
        if (config.id === 'orchestrator-accounting-intent') {
          return { ...config, generate: accountingIntentGenerate } as never;
        }
        return {
          ...config,
          generate: Object.keys((config.tools as Record<string, unknown> | undefined) ?? {}).length === 0
            ? finalizerGenerate
            : mainGenerate,
        } as never;
      },
      teams: [queryTeam, accountingTeam],
      teamRuntime: { runTeamLead },
    });

    const result = await orchestrator.runTurn({
      message: message('Record a USD 10.00 burger purchase from checking on 2026-06-27 in dining out.'),
    });

    expect(mainGenerate).toHaveBeenCalledTimes(1);
    expect(accountingIntentGenerate).toHaveBeenCalledTimes(1);
    expect(finalizerGenerate).not.toHaveBeenCalled();
    expect(runTeamLead).toHaveBeenCalledWith(expect.objectContaining({
      team: accountingTeam,
      request: expect.objectContaining({
        schemaName: 'accounting-lead-request',
        schemaVersion: 1,
        intent: 'transaction_capture',
        request: expect.objectContaining({
          schemaName: 'transaction-capture-request-draft',
          known: expect.objectContaining({
            amount: '10.00',
            currency: 'USD',
            occurredOn: '2026-06-27',
            paymentAccountName: 'checking',
            categoryName: 'dining out',
          }),
        }),
      }),
    }));
    expect(result).toMatchObject({
      kind: 'ask-user',
      response: {
        body: expect.stringContaining('Which internal payment account should this use?'),
      },
    });
  });

  it('routes internal transfers to accounting journal work when the reasoning model answers directly', async () => {
    const runTeamLead = vi.fn(async () => insufficientEvidenceResult());
    const mainGenerate = vi.fn(async () => ({ text: 'Transfer recorded.' }));
    const accountingIntentGenerate = vi.fn(async () => ({
      object: {
        shouldDelegateTransactionCapture: false,
        shouldDelegateJournal: true,
        journalOperation: 'transfer',
        instruction: 'transfer $1000 from my savings to my checking account',
        known: {},
      },
    }));
    const finalizerGenerate = vi.fn();
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => {
        if (config.id === 'orchestrator-accounting-intent') {
          return { ...config, generate: accountingIntentGenerate } as never;
        }
        return {
          ...config,
          generate: Object.keys((config.tools as Record<string, unknown> | undefined) ?? {}).length === 0
            ? finalizerGenerate
            : mainGenerate,
        } as never;
      },
      teams: [queryTeam, accountingTeam],
      teamRuntime: { runTeamLead },
    });

    const result = await orchestrator.runTurn({
      message: message('transfer $1000 from my savings to my checking account'),
    });

    expect(accountingIntentGenerate).toHaveBeenCalledTimes(1);
    expect(runTeamLead).toHaveBeenCalledWith(expect.objectContaining({
      team: accountingTeam,
      request: expect.objectContaining({
        schemaName: 'accounting-lead-request',
        schemaVersion: 1,
        intent: 'journal',
        request: expect.objectContaining({
          operation: 'transfer',
          instruction: 'transfer $1000 from my savings to my checking account',
        }),
      }),
    }));
    expect(result).toMatchObject({
      kind: 'ask-user',
      response: {
        body: expect.stringContaining('Which internal payment account should this use?'),
      },
    });
  });

  it('fails instead of wrapping invalid no-team model output as plain text', async () => {
    const mainGenerate = vi.fn(async () => ({ text: 'I recorded it.' }));
    const accountingIntentGenerate = vi.fn(async () => ({
      object: { shouldDelegateTransactionCapture: false, known: {} },
    }));
    const queryIntentGenerate = vi.fn(async () => ({
      object: { shouldDelegateQuery: false, desiredGrain: [], requiredCalculations: [], coverage: [] },
    }));
    const finalizerGenerate = vi.fn(async () => ({ text: 'still not structured' }));
    const orchestrator = new OrchestratorAgent({
      model: { id: 'deepseek/deepseek-v4-flash', endpoint: 'https://api.deepseek.com', apiKey: 'test-api-key' },
      agentFactory: (config) => {
        if (config.id === 'orchestrator-accounting-intent') {
          return { ...config, generate: accountingIntentGenerate } as never;
        }
        if (config.id === 'orchestrator-query-intent') {
          return { ...config, generate: queryIntentGenerate } as never;
        }
        return {
          ...config,
          generate: Object.keys((config.tools as Record<string, unknown> | undefined) ?? {}).length === 0
            ? finalizerGenerate
            : mainGenerate,
        } as never;
      },
      teams: [queryTeam],
      teamRuntime: { runTeamLead: vi.fn() },
    });

    await expect(orchestrator.run({ message: message('What can you do?') }))
      .rejects.toThrow();
    expect(mainGenerate).toHaveBeenCalledTimes(1);
    expect(accountingIntentGenerate).toHaveBeenCalledTimes(1);
    expect(queryIntentGenerate).toHaveBeenCalledTimes(1);
    expect(finalizerGenerate).toHaveBeenCalledTimes(1);
  });

  it('rejects non-canonical delegate tool input before team execution', async () => {
    const runTeamLead = vi.fn();
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate: vi.fn() }) as never,
      teams: [queryTeam],
      teamRuntime: { runTeamLead },
    });

    const execute = orchestrator.agentTools.delegateTeam.execute as unknown as (
      input: unknown,
      options: unknown,
    ) => Promise<unknown>;
    await expect(execute({ team: 'Query Team', request: 'test' }, {})).resolves.toMatchObject({ error: true });
    await expect(execute({ team: 'query', request: '"test"' }, {})).resolves.toMatchObject({ error: true });
    expect(runTeamLead).not.toHaveBeenCalled();
  });
});

async function executeDelegate(
  tool: typeof OrchestratorAgent.prototype.agentTools.delegateTeam,
  input: { team: string; request: unknown },
): Promise<TeamResultEnvelopeV1> {
  const execute = tool.execute as unknown as (input: unknown, options: unknown) => Promise<unknown>;
  return TeamResultEnvelopeSchemaV1.parse(await execute(input, {}));
}
