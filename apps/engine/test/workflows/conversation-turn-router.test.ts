import { describe, expect, it, vi } from 'vitest';
import {
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  PendingInteractionSchemaV1,
  type PendingInteractionV1,
} from '@plus-one/contracts';
import type { PendingInteractionRepository } from '@plus-one/database';
import type { WorkingMemoryResolutionResult } from '../../src/agents/orchestrator.js';
import { runConversationTurn } from '../../src/workflows/conversation-turn-router.js';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const conversationId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const principalRef = 'telegram:user:1';

const pending = PendingInteractionSchemaV1.parse({
  schemaName: 'pending-interaction',
  schemaVersion: 1,
  interactionId: 'wmproposal_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  kind: 'working_memory_confirmation',
  householdId,
  conversationId,
  speakerPrincipalRef: principalRef,
  pendingWorkingMemoryMutation: {
    proposalId: 'wmproposal_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    householdId,
    conversationId,
    speakerPrincipalRef: principalRef,
    mutation: {
      operation: 'create',
      entryId: 'wme_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      entry: {
        kind: 'goal',
        summary: 'Buy a BMW X5.',
        scope: 'household',
        value: { goal: 'BMW X5' },
      },
    },
    basedOnRevision: 'a'.repeat(64),
    createdAt: '2026-07-06T00:00:00.000Z',
    expiresAt: '2026-07-06T00:15:00.000Z',
  },
  status: 'pending',
  version: 0,
  createdAt: '2026-07-06T00:00:00.000Z',
  expiresAt: '2026-07-06T00:15:00.000Z',
});

const message = (body: string, externalMessageId: string) => InboundChannelMessageSchemaV1.parse({
  schemaName: 'inbound-channel-message',
  schemaVersion: 1,
  conversationId,
  householdId,
  channel: 'telegram',
  externalMessageId,
  receivedAt: '2026-07-06T00:05:00.000Z',
  speaker: { principalRef },
  body,
  attachments: [],
  metadata: { destination: { chatId: 'chat-1' } },
});

function response(body: string) {
  return OrchestratorFinalResponseSchemaV1.parse({
    schemaName: 'orchestrator-final-response',
    schemaVersion: 1,
    responseId: `response_${body.replace(/[^a-z]+/gi, '_')}`,
    householdId,
    conversationId,
    body,
    policyBoundary: 'personalized_finance',
    citations: [{ label: 'router:test', sourceRef: 'test' }],
    assumptions: [],
    freshness: ['current invocation'],
    disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
    unsupportedCapabilities: [],
    recommendationActions: [],
    delivery: { channel: 'telegram', destination: { chatId: 'chat-1' }, format: 'plain_text' },
    responseHash: 'a'.repeat(64),
    createdAt: '2026-07-06T00:05:00.000Z',
  });
}

class InMemoryPendingInteractions implements PendingInteractionRepository {
  readonly records = new Map<string, PendingInteractionV1>();

  async create(candidate: PendingInteractionV1): Promise<PendingInteractionV1> {
    const value = PendingInteractionSchemaV1.parse(candidate);
    const existing = this.records.get(value.interactionId);
    if (existing !== undefined) return existing;
    this.records.set(value.interactionId, value);
    return value;
  }

  async findOpen(input: { householdId: string; conversationId: string; speakerPrincipalRef: string }) {
    return [...this.records.values()].find((record) =>
      record.householdId === input.householdId
      && record.conversationId === input.conversationId
      && record.speakerPrincipalRef === input.speakerPrincipalRef
      && (record.status === 'pending' || record.status === 'resolving'));
  }

  async findById(input: { householdId: string; interactionId: string }) {
    const record = this.records.get(input.interactionId);
    return record?.householdId === input.householdId ? record : undefined;
  }

  async findByResolutionMessage(input: { householdId: string; conversationId: string; externalMessageId: string }) {
    return [...this.records.values()].find((record) =>
      record.householdId === input.householdId
      && record.conversationId === input.conversationId
      && record.resolutionExternalMessageId === input.externalMessageId);
  }

  async claim(input: {
    householdId: string;
    interactionId: string;
    externalMessageId: string;
    expectedVersion: number;
  }) {
    const record = await this.findById(input);
    if (record === undefined) throw new Error('missing pending interaction');
    if (record.resolutionExternalMessageId === input.externalMessageId) return { kind: 'replay' as const, interaction: record };
    if (record.status !== 'pending' || record.version !== input.expectedVersion) throw new Error('pending interaction changed');
    const claimed = PendingInteractionSchemaV1.parse({
      ...record,
      status: 'resolving',
      version: record.version + 1,
      resolutionExternalMessageId: input.externalMessageId,
    });
    this.records.set(record.interactionId, claimed);
    return { kind: 'claimed' as const, interaction: claimed };
  }

  async complete(input: {
    householdId: string;
    interactionId: string;
    expectedVersion: number;
    status: 'applied' | 'rejected' | 'expired' | 'stale' | 'failed';
    resolutionCode: string;
    resolutionResponse: ReturnType<typeof response>;
    resolvedAt: string;
  }) {
    const record = await this.findById(input);
    if (record === undefined || record.version !== input.expectedVersion) throw new Error('pending interaction changed');
    const completed = PendingInteractionSchemaV1.parse({
      ...record,
      status: input.status,
      version: record.version + 1,
      resolutionCode: input.resolutionCode,
      resolutionResponse: input.resolutionResponse,
      resolvedAt: input.resolvedAt,
    });
    this.records.set(record.interactionId, completed);
    return completed;
  }
}

function dependencies(input: {
  repository: InMemoryPendingInteractions;
  disposition: 'approve' | 'reject' | 'new_intent' | 'ambiguous';
  resolvedStatus?: 'applied' | 'rejected' | 'expired' | 'stale' | 'failed';
}) {
  const normal = vi.fn(async () => response('Handled as a new request.'));
  const classify = vi.fn(async () => input.disposition);
  const resolve = vi.fn(async ({ decision }: { decision: 'approve' | 'reject' | 'ambiguous' }): Promise<WorkingMemoryResolutionResult> => ({
    status: input.resolvedStatus ?? (decision === 'approve' ? 'applied' : decision === 'reject' ? 'rejected' : 'pending'),
    code: input.resolvedStatus === 'expired' ? 'working_memory_proposal_expired' : `working_memory_${decision}`,
    response: response(`Resolved ${decision}.`),
  }));
  const finalize = vi.fn(async ({ status, code }: { status: 'applied' | 'rejected' | 'expired' | 'stale' | 'failed'; code: string }) => ({
    status,
    code,
    response: response(`Recovered ${code}.`),
  }));
  return {
    pendingInteractions: input.repository,
    orchestrator: {
      classifyPendingWorkingMemoryInput: classify,
      resolvePendingWorkingMemoryMutation: resolve,
      finalizePendingWorkingMemoryResolution: finalize,
    },
    runNormalTurn: normal,
    mocks: { normal, classify, resolve, finalize },
  } as const;
}

describe('conversation turn router', () => {
  it('runs the normal loop when no Working Memory interaction is open', async () => {
    const repository = new InMemoryPendingInteractions();
    const deps = dependencies({ repository, disposition: 'new_intent' });

    await expect(runConversationTurn(deps, { message: message('What did we spend?', 'message-1') }))
      .resolves.toMatchObject({ body: 'Handled as a new request.' });
    expect(deps.mocks.normal).toHaveBeenCalledOnce();
    expect(deps.mocks.classify).not.toHaveBeenCalled();
  });

  it.each([
    ['new_intent', 'What is our budget for July?', 'Handled as a new request.'],
    ['ambiguous', 'Actually, maybe that one?', 'Resolved ambiguous.'],
    ['approve', 'yes', 'Resolved approve.'],
    ['reject', 'no', 'Resolved reject.'],
  ] as const)('routes %s without losing the pending interaction contract', async (disposition, body, expectedBody) => {
    const repository = new InMemoryPendingInteractions();
    await repository.create(pending);
    const deps = dependencies({ repository, disposition });

    await expect(runConversationTurn(deps, { message: message(body, `message-${disposition}`) }))
      .resolves.toMatchObject({ body: expectedBody });
    expect(deps.mocks.classify).toHaveBeenCalledOnce();
    if (disposition === 'new_intent') {
      expect(deps.mocks.resolve).not.toHaveBeenCalled();
      expect((await repository.findOpen({ householdId, conversationId, speakerPrincipalRef: principalRef }))?.status).toBe('pending');
    } else if (disposition === 'ambiguous') {
      expect(deps.mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ decision: 'ambiguous' }));
      expect((await repository.findOpen({ householdId, conversationId, speakerPrincipalRef: principalRef }))?.status).toBe('pending');
    } else {
      expect(deps.mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ decision: disposition }));
      expect((await repository.findById({ householdId, interactionId: pending.interactionId }))?.status).toBe(
        disposition === 'approve' ? 'applied' : 'rejected',
      );
    }
  });

  it('keeps a pending interaction when semantic classification fails', async () => {
    const repository = new InMemoryPendingInteractions();
    await repository.create(pending);
    const deps = dependencies({ repository, disposition: 'approve' });
    const classify = vi.fn(async () => { throw new Error('semantic provider unavailable'); });

    await expect(runConversationTurn({
      ...deps,
      orchestrator: { ...deps.orchestrator, classifyPendingWorkingMemoryInput: classify },
    }, { message: message('Ya, silakan simpan.', 'message-classifier-failure') }))
      .resolves.toMatchObject({ body: 'Resolved ambiguous.' });
    expect((await repository.findOpen({ householdId, conversationId, speakerPrincipalRef: principalRef }))?.status)
      .toBe('pending');
    expect(deps.mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ decision: 'ambiguous' }));
  });

  it('completes an expired approval as expired', async () => {
    const repository = new InMemoryPendingInteractions();
    await repository.create(PendingInteractionSchemaV1.parse({
      ...pending,
      createdAt: '2026-07-05T23:45:00.000Z',
      expiresAt: '2026-07-06T00:00:00.000Z',
      pendingWorkingMemoryMutation: {
        ...pending.pendingWorkingMemoryMutation,
        createdAt: '2026-07-05T23:45:00.000Z',
        expiresAt: '2026-07-06T00:00:00.000Z',
      },
    }));
    const deps = dependencies({ repository, disposition: 'approve', resolvedStatus: 'expired' });

    await runConversationTurn(deps, { message: message('yes', 'message-expired') });

    expect(deps.mocks.resolve).toHaveBeenCalledOnce();
    expect((await repository.findById({ householdId, interactionId: pending.interactionId }))?.status).toBe('expired');
  });

  it('replays a completed resolution without classifying or applying again', async () => {
    const repository = new InMemoryPendingInteractions();
    await repository.create(pending);
    const deps = dependencies({ repository, disposition: 'approve' });
    const approval = message('yes', 'message-replay');

    await runConversationTurn(deps, { message: approval });
    const firstResolveCount = deps.mocks.resolve.mock.calls.length;
    const second = await runConversationTurn(deps, { message: approval });

    expect(second.body).toBe('Resolved approve.');
    expect(deps.mocks.resolve).toHaveBeenCalledTimes(firstResolveCount);
    expect(deps.mocks.classify).toHaveBeenCalledOnce();
  });

  it('recovers a resolving interaction whose target effect is already present', async () => {
    const repository = new InMemoryPendingInteractions();
    repository.records.set(pending.interactionId, PendingInteractionSchemaV1.parse({
      ...pending,
      status: 'resolving',
      version: 1,
      resolutionExternalMessageId: 'message-crashed',
    }));
    const deps = dependencies({ repository, disposition: 'approve' });
    const mutation = pending.pendingWorkingMemoryMutation.mutation;
    if (mutation.operation !== 'create') throw new Error('Expected a create mutation fixture.');
    const inspectWorkingMemory = vi.fn(async () => ({
      status: 'succeeded' as const,
      document: {
        version: 1 as const,
        entries: {
          [mutation.entryId]: mutation.entry,
        },
      },
      inspection: { revision: 'b'.repeat(64), entries: [] },
      outcome: { operation: 'inspect' as const, status: 'succeeded' as const, code: 'working_memory_inspection_succeeded' },
    }));

    const responseFromRecovery = await runConversationTurn({
      ...deps,
      sessionMemory: { inspectWorkingMemory } as never,
    }, { message: message('yes', 'message-crashed') });

    expect(responseFromRecovery.body).toBe('Recovered working_memory_mutation_recovered.');
    expect(inspectWorkingMemory).toHaveBeenCalledOnce();
    expect(deps.mocks.resolve).not.toHaveBeenCalled();
    expect(deps.mocks.finalize).toHaveBeenCalledWith(expect.objectContaining({
      status: 'applied',
      code: 'working_memory_mutation_recovered',
    }));
    expect((await repository.findById({ householdId, interactionId: pending.interactionId }))?.status).toBe('applied');
  });

  it('marks a resolving interaction stale when live context changed before the effect appeared', async () => {
    const repository = new InMemoryPendingInteractions();
    repository.records.set(pending.interactionId, PendingInteractionSchemaV1.parse({
      ...pending,
      status: 'resolving',
      version: 1,
      resolutionExternalMessageId: 'message-stale',
    }));
    const deps = dependencies({ repository, disposition: 'approve' });
    const inspectWorkingMemory = vi.fn(async () => ({
      status: 'succeeded' as const,
      document: { version: 1 as const, entries: {} },
      inspection: { revision: 'b'.repeat(64), entries: [] },
      outcome: { operation: 'inspect' as const, status: 'succeeded' as const, code: 'working_memory_inspection_succeeded' },
    }));

    await runConversationTurn({
      ...deps,
      sessionMemory: { inspectWorkingMemory } as never,
    }, { message: message('yes', 'message-stale') });

    expect(deps.mocks.resolve).not.toHaveBeenCalled();
    expect(deps.mocks.finalize).toHaveBeenCalledWith(expect.objectContaining({
      status: 'stale',
      code: 'working_memory_revision_stale',
    }));
    expect((await repository.findById({ householdId, interactionId: pending.interactionId }))?.status).toBe('stale');
  });

  it('fails a resolving interaction when Working Memory inspection returns a failure', async () => {
    const repository = new InMemoryPendingInteractions();
    repository.records.set(pending.interactionId, PendingInteractionSchemaV1.parse({
      ...pending,
      status: 'resolving',
      version: 1,
      resolutionExternalMessageId: 'message-inspection-failed',
    }));
    const deps = dependencies({ repository, disposition: 'approve' });
    const applyWorkingMemoryMutation = vi.fn();
    const inspectWorkingMemory = vi.fn(async () => ({
      status: 'failed' as const,
      outcome: {
        operation: 'inspect' as const,
        status: 'failed' as const,
        code: 'working_memory_read_failed',
        category: 'storage_unavailable' as const,
        retry: 'after_backoff' as const,
      },
      error: new Error('Working Memory storage unavailable'),
    }));

    const recovered = await runConversationTurn({
      ...deps,
      sessionMemory: { inspectWorkingMemory, applyWorkingMemoryMutation } as never,
    }, { message: message('yes', 'message-inspection-failed') });

    expect(recovered.body).toBe('Recovered working_memory_storage_unavailable.');
    expect(inspectWorkingMemory).toHaveBeenCalledOnce();
    expect(deps.mocks.resolve).not.toHaveBeenCalled();
    expect(applyWorkingMemoryMutation).not.toHaveBeenCalled();
    expect(deps.mocks.finalize).toHaveBeenCalledWith({
      message: expect.anything(),
      pending: pending.pendingWorkingMemoryMutation,
      status: 'failed',
      code: 'working_memory_storage_unavailable',
      directive: 'The change could not be recovered. Do not say it was completed.',
    });
    expect((await repository.findById({ householdId, interactionId: pending.interactionId }))?.status).toBe('failed');
  });
});
