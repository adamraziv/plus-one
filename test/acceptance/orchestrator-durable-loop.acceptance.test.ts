import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import {
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  PendingInteractionSchemaV1,
  PendingWorkingMemoryMutationSchema,
  type InboundChannelMessageV1,
} from '@plus-one/contracts';
import { PostgresPendingInteractionRepository } from '@plus-one/database';
import { createMastra } from '../../apps/engine/src/mastra.js';
import { createRuntimeRoutes } from '../../apps/engine/src/runtime-routes.js';
import { createOrchestratorSessionMemory } from '../../apps/engine/src/memory/orchestrator-session-memory.js';
import {
  workingMemoryMutationEffectIsPresent,
  workingMemoryRevision,
} from '../../apps/engine/src/memory/working-memory-document.js';
import {
  createOrchestratorLoopWorkflow,
  runOrchestratorLoop,
} from '../../apps/engine/src/workflows/orchestrator-loop.js';
import { runConversationTurn } from '../../apps/engine/src/workflows/conversation-turn-router.js';
import {
  pendingChartResultFixture as pendingTeamResult,
  pendingEffectFixture,
} from '../../apps/engine/test/helpers/pending-chart-result.js';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const conversationId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const now = '2026-08-03T10:00:00.000Z';

let context: PostgresTestContext | undefined;
let mastra: ReturnType<typeof createMastra> | undefined;

afterEach(async () => {
  const storage = mastra?.getStorage();
  const close = storage?.close?.bind(storage);
  if (close !== undefined) await close();
  mastra = undefined;
  await context?.cleanup();
  context = undefined;
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
    citations: [{ label: 'orchestrator:test', sourceRef: 'test' }],
    assumptions: [],
    freshness: ['current invocation'],
    disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
    unsupportedCapabilities: [],
    recommendationActions: [],
    delivery: { channel: 'telegram', destination: { chatId: 'live-chat' }, format: 'plain_text' },
    responseHash: 'a'.repeat(64),
    createdAt: now,
  });
}

function message(body: string, externalMessageId: string) {
  return InboundChannelMessageSchemaV1.parse({
    schemaName: 'inbound-channel-message',
    schemaVersion: 1,
    conversationId,
    householdId,
    channel: 'telegram',
    externalMessageId,
    receivedAt: now,
    speaker: { principalRef: 'telegram:user:1' },
    body,
    attachments: [],
    metadata: { destination: { chatId: 'live-chat' } },
  });
}

describe('orchestrator durable loop acceptance', () => {
  it('keeps a Working Memory confirmation pending across an unrelated Indonesian budget request and restart', async () => {
    context = await createPostgresTestContext('orchestrator_loop_issue_33');
    const firstPool = new Pool({ connectionString: context.roleUrls.operations });
    await firstPool.query(
      `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
       VALUES ($1, 'USD', 'UTC')`,
      [householdId],
    );
    const firstRepository = new PostgresPendingInteractionRepository(firstPool);
    const emptyDocument = { version: 1 as const, entries: {} };
    const pendingWorkingMemoryMutation = PendingWorkingMemoryMutationSchema.parse({
      proposalId: 'wmproposal_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      householdId,
      conversationId,
      speakerPrincipalRef: 'telegram:user:1',
      mutation: {
        operation: 'create',
        entryId: 'wme_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        entry: {
          kind: 'communication_preference',
          summary: 'Use concise replies.',
          scope: 'household',
          value: { detail: 'concise' },
        },
      },
      basedOnRevision: workingMemoryRevision(emptyDocument),
      createdAt: '2026-08-03T10:00:00.000Z',
      expiresAt: '2026-08-03T10:15:00.000Z',
    });
    const model = {
      id: 'openai/gpt-5',
      endpoint: 'https://llm.example.test/v1',
      apiKey: 'test-api-key',
    };
    let firstSessionMemory: ReturnType<typeof createOrchestratorSessionMemory> | undefined;
    let secondSessionMemory: ReturnType<typeof createOrchestratorSessionMemory> | undefined;
    let firstMastra: ReturnType<typeof createMastra> | undefined;
    let secondMastra: ReturnType<typeof createMastra> | undefined;
    let secondPool: Pool | undefined;

    try {
      firstSessionMemory = createOrchestratorSessionMemory({
        connectionString: context.roleUrls.memory,
        model,
      });
      const budgetRun = vi.fn();
      const firstOrchestrator = {
        runTurn: vi.fn(async ({ message: inbound }: { message: InboundChannelMessageV1 }) => {
          if (inbound.body.includes('Uang makan')) {
            budgetRun();
            return { kind: 'final' as const, response: response('Budget dibuat dan diverifikasi.') };
          }
          return {
            kind: 'ask-user' as const,
            response: response('I can save the concise-reply preference. Would you like me to proceed?'),
            pendingWorkingMemoryMutation,
          };
        }),
        classifyPendingWorkingMemoryInput: vi.fn(async () => 'new_intent' as const),
        resolvePendingWorkingMemoryMutation: vi.fn(),
        finalizePendingWorkingMemoryResolution: vi.fn(),
        synthesizePendingWorkingMemoryConfirmation: vi.fn(async () => response(
          'I can save the concise-reply preference. Would you like me to proceed?',
        )),
      };
      firstMastra = createMastra(
        context.roleUrls.memory,
        {},
        [],
        { 'orchestrator-loop': createOrchestratorLoopWorkflow(firstOrchestrator as never, firstRepository, firstSessionMemory) },
      );

      const first = await runOrchestratorLoop({
        workflow: firstMastra.getWorkflow('orchestrator-loop'),
        message: message('Please remember that we prefer concise replies.', 'message-1'),
        pendingInteractions: firstRepository,
        orchestrator: firstOrchestrator as never,
        sessionMemory: firstSessionMemory,
      });
      expect(first.body).toContain('concise-reply preference');

      const unrelated = await runOrchestratorLoop({
        workflow: firstMastra.getWorkflow('orchestrator-loop'),
        message: message('1. Uang makan 2 juta; 2. Transport 1 juta', 'message-2'),
        pendingInteractions: firstRepository,
        orchestrator: firstOrchestrator as never,
        sessionMemory: firstSessionMemory,
      });
      expect(unrelated.body).toBe('Budget dibuat dan diverifikasi.');
      expect(budgetRun).toHaveBeenCalledOnce();
      expect(firstOrchestrator.resolvePendingWorkingMemoryMutation).not.toHaveBeenCalled();
      await expect(firstRepository.findOpen({
        householdId,
        conversationId,
        speakerPrincipalRef: 'telegram:user:1',
      })).resolves.toMatchObject({
        status: 'pending',
        pendingWorkingMemoryMutation,
      });

      await firstMastra.getStorage()?.close?.();
      await firstSessionMemory.close();
      await firstPool.end();
      firstMastra = undefined;
      firstSessionMemory = undefined;

      secondPool = new Pool({ connectionString: context.roleUrls.operations });
      const secondRepository = new PostgresPendingInteractionRepository(secondPool);
      secondSessionMemory = createOrchestratorSessionMemory({
        connectionString: context.roleUrls.memory,
        model,
      });
      const applyWorkingMemoryMutation = vi.spyOn(secondSessionMemory, 'applyWorkingMemoryMutation');
      const secondOrchestrator = {
        runTurn: vi.fn(),
        classifyPendingWorkingMemoryInput: vi.fn(async () => 'approve' as const),
        resolvePendingWorkingMemoryMutation: vi.fn(async ({
          message: inbound,
          pending,
        }: {
          message: InboundChannelMessageV1;
          pending: typeof pendingWorkingMemoryMutation;
        }) => {
          const applied = await secondSessionMemory!.applyWorkingMemoryMutation({
            threadId: inbound.conversationId,
            resourceId: inbound.householdId,
            principalRef: inbound.speaker.principalRef,
            basedOnRevision: pending.basedOnRevision,
            mutation: pending.mutation,
          });
          if (applied.status !== 'succeeded') {
            return {
              status: 'failed' as const,
              code: applied.code,
              response: response('The preference was not saved.'),
            };
          }
          return {
            status: 'applied' as const,
            code: 'working_memory_mutation_succeeded',
            response: response('The language preference was saved and verified.'),
          };
        }),
        finalizePendingWorkingMemoryResolution: vi.fn(),
        synthesizePendingWorkingMemoryConfirmation: vi.fn(),
      };
      secondMastra = createMastra(
        context.roleUrls.memory,
        {},
        [],
        { 'orchestrator-loop': createOrchestratorLoopWorkflow(secondOrchestrator as never, secondRepository, secondSessionMemory) },
      );

      const approved = await runOrchestratorLoop({
        workflow: secondMastra.getWorkflow('orchestrator-loop'),
        message: message('yes', 'message-3'),
        pendingInteractions: secondRepository,
        orchestrator: secondOrchestrator as never,
        sessionMemory: secondSessionMemory,
      });
      expect(approved.body).toBe('The language preference was saved and verified.');
      expect(applyWorkingMemoryMutation).toHaveBeenCalledOnce();
      expect(budgetRun).toHaveBeenCalledOnce();
      await expect(secondRepository.findById({ householdId, interactionId: pendingWorkingMemoryMutation.proposalId }))
        .resolves.toMatchObject({ status: 'applied', resolutionExternalMessageId: 'message-3' });
      const readback = await secondSessionMemory.inspectWorkingMemory({
        threadId: conversationId,
        resourceId: householdId,
        principalRef: 'telegram:user:1',
      });
      expect(readback.status).toBe('succeeded');
      if (readback.status === 'succeeded') {
        expect(workingMemoryMutationEffectIsPresent({
          document: readback.document,
          mutation: pendingWorkingMemoryMutation.mutation,
        })).toBe(true);
      }
      await secondMastra.getStorage()?.close?.();
      await secondSessionMemory.close();
      await secondPool.end();
      secondPool = undefined;
      secondMastra = undefined;
      secondSessionMemory = undefined;
    } finally {
      await firstMastra?.getStorage()?.close?.();
      await secondMastra?.getStorage()?.close?.();
      await firstSessionMemory?.close();
      await secondSessionMemory?.close();
      await firstPool.end().catch(() => undefined);
      await secondPool?.end().catch(() => undefined);
    }
  });

  it('records rejection, ambiguity, expiry, stale outcomes, and duplicate approval replay', async () => {
    context = await createPostgresTestContext('orchestrator_loop_resolution_matrix');
    const pool = new Pool({ connectionString: context.roleUrls.operations });
    await pool.query(
      `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
       VALUES ($1, 'USD', 'UTC')`,
      [householdId],
    );
    const repository = new PostgresPendingInteractionRepository(pool);
    const terminalResponse = response('No change was made.');
    const openResponse = response('I am still waiting for a clear answer.');
    const normal = vi.fn(async () => response('Handled as a normal turn.'));

    const addPending = async (proposalId: string, createdAt = '2026-08-03T10:00:00.000Z', expiresAt = '2026-08-03T10:15:00.000Z') => {
      const pending = PendingWorkingMemoryMutationSchema.parse({
        proposalId,
        householdId,
        conversationId,
        speakerPrincipalRef: 'telegram:user:1',
        mutation: {
          operation: 'create',
          entryId: `wme_${proposalId.slice('wmproposal_'.length)}`,
          entry: {
            kind: 'communication_preference',
            summary: 'Use concise replies.',
            scope: 'household',
            value: { detail: 'concise' },
          },
        },
        basedOnRevision: 'a'.repeat(64),
        createdAt,
        expiresAt,
      });
      return repository.create(PendingInteractionSchemaV1.parse({
        schemaName: 'pending-interaction',
        schemaVersion: 1,
        interactionId: proposalId,
        kind: 'working_memory_confirmation',
        householdId,
        conversationId,
        speakerPrincipalRef: 'telegram:user:1',
        pendingWorkingMemoryMutation: pending,
        status: 'pending',
        version: 0,
        createdAt,
        expiresAt,
      }));
    };

    try {
      const rejected = await addPending('wmproposal_01JNZQ4A9B8C7D6E5F4G3H2J1K');
      const rejectionResolver = vi.fn(async () => ({
        status: 'rejected' as const,
        code: 'working_memory_mutation_rejected',
        response: terminalResponse,
      }));
      await runConversationTurn({
        pendingInteractions: repository,
        orchestrator: {
          classifyPendingWorkingMemoryInput: vi.fn(async () => 'reject' as const),
          resolvePendingWorkingMemoryMutation: rejectionResolver,
          finalizePendingWorkingMemoryResolution: vi.fn(),
        } as never,
        runNormalTurn: normal,
      }, { message: message('no', 'matrix-reject') });
      await expect(repository.findById({ householdId, interactionId: rejected.interactionId }))
        .resolves.toMatchObject({ status: 'rejected', resolutionCode: 'working_memory_mutation_rejected' });
      expect(terminalResponse.body).not.toMatch(/saved|stored|completed/i);

      const ambiguous = await addPending('wmproposal_01JNZQ4A9B8C7D6E5F4G3H2J1M');
      const ambiguousResolver = vi.fn(async () => ({
        status: 'pending' as const,
        code: 'working_memory_confirmation_required',
        response: openResponse,
      }));
      await runConversationTurn({
        pendingInteractions: repository,
        orchestrator: {
          classifyPendingWorkingMemoryInput: vi.fn(async () => 'ambiguous' as const),
          resolvePendingWorkingMemoryMutation: ambiguousResolver,
          finalizePendingWorkingMemoryResolution: vi.fn(),
        } as never,
        runNormalTurn: normal,
      }, { message: message('maybe that one?', 'matrix-ambiguous') });
      await expect(repository.findOpen({
        householdId,
        conversationId,
        speakerPrincipalRef: 'telegram:user:1',
      })).resolves.toMatchObject({ interactionId: ambiguous.interactionId, status: 'pending' });
      expect(ambiguousResolver).toHaveBeenCalledWith(expect.objectContaining({ decision: 'ambiguous' }));
      const ambiguousClaim = await repository.claim({
        householdId,
        interactionId: ambiguous.interactionId,
        externalMessageId: 'matrix-ambiguous-cleanup',
        decision: 'reject',
        expectedVersion: ambiguous.version,
      });
      if (ambiguousClaim.kind !== 'claimed') throw new Error('Expected the ambiguous fixture to remain claimable.');
      await repository.complete({
        householdId,
        interactionId: ambiguous.interactionId,
        expectedVersion: ambiguousClaim.interaction.version,
        status: 'rejected',
        resolutionCode: 'working_memory_mutation_rejected',
        resolutionResponse: terminalResponse,
        resolvedAt: now,
      });

      const expired = await addPending(
        'wmproposal_01JNZQ4A9B8C7D6E5F4G3H2J1N',
        '2026-08-02T10:00:00.000Z',
        '2026-08-02T10:15:00.000Z',
      );
      const expiredResolver = vi.fn(async () => ({
        status: 'expired' as const,
        code: 'working_memory_proposal_expired',
        response: response('The proposal expired and was not completed.'),
      }));
      await runConversationTurn({
        pendingInteractions: repository,
        orchestrator: {
          classifyPendingWorkingMemoryInput: vi.fn(async () => 'approve' as const),
          resolvePendingWorkingMemoryMutation: expiredResolver,
          finalizePendingWorkingMemoryResolution: vi.fn(),
        } as never,
        runNormalTurn: normal,
      }, { message: message('yes', 'matrix-expired') });
      await expect(repository.findById({ householdId, interactionId: expired.interactionId }))
        .resolves.toMatchObject({ status: 'expired', resolutionCode: 'working_memory_proposal_expired' });

      const stale = await addPending('wmproposal_01JNZQ4A9B8C7D6E5F4G3H2J1P');
      const staleResolver = vi.fn(async () => ({
        status: 'stale' as const,
        code: 'working_memory_revision_stale',
        response: response('The context changed, so the proposal was not completed.'),
      }));
      await runConversationTurn({
        pendingInteractions: repository,
        orchestrator: {
          classifyPendingWorkingMemoryInput: vi.fn(async () => 'approve' as const),
          resolvePendingWorkingMemoryMutation: staleResolver,
          finalizePendingWorkingMemoryResolution: vi.fn(),
        } as never,
        runNormalTurn: normal,
      }, { message: message('yes', 'matrix-stale') });
      await expect(repository.findById({ householdId, interactionId: stale.interactionId }))
        .resolves.toMatchObject({ status: 'stale', resolutionCode: 'working_memory_revision_stale' });

      const duplicate = await addPending('wmproposal_01JNZQ4A9B8C7D6E5F4G3H2J1Q');
      const duplicateResolver = vi.fn(async () => ({
        status: 'applied' as const,
        code: 'working_memory_mutation_succeeded',
        response: response('The change was saved and verified.'),
      }));
      const duplicateClassifier = vi.fn(async () => 'approve' as const);
      const duplicateDependencies = {
        pendingInteractions: repository,
        orchestrator: {
          classifyPendingWorkingMemoryInput: duplicateClassifier,
          resolvePendingWorkingMemoryMutation: duplicateResolver,
          finalizePendingWorkingMemoryResolution: vi.fn(),
        } as never,
        runNormalTurn: normal,
      };
      await runConversationTurn(duplicateDependencies, { message: message('yes', 'matrix-duplicate') });
      const replay = await runConversationTurn(duplicateDependencies, { message: message('yes', 'matrix-duplicate') });
      expect(replay.body).toBe('The change was saved and verified.');
      expect(duplicateResolver).toHaveBeenCalledOnce();
      expect(duplicateClassifier).toHaveBeenCalledOnce();
      await expect(repository.findById({ householdId, interactionId: duplicate.interactionId }))
        .resolves.toMatchObject({ status: 'applied', resolutionExternalMessageId: 'matrix-duplicate' });
    } finally {
      await pool.end();
    }
  });

  it('recovers a resolving interaction when the Working Memory effect is already present', async () => {
    context = await createPostgresTestContext('orchestrator_loop_crash_recovery');
    const pool = new Pool({ connectionString: context.roleUrls.operations });
    await pool.query(
      `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
       VALUES ($1, 'USD', 'UTC')`,
      [householdId],
    );
    const repository = new PostgresPendingInteractionRepository(pool);
    const model = {
      id: 'openai/gpt-5',
      endpoint: 'https://llm.example.test/v1',
      apiKey: 'test-api-key',
    };
    const sessionMemory = createOrchestratorSessionMemory({
      connectionString: context.roleUrls.memory,
      model,
    });
    try {
      const emptyDocument = { version: 1 as const, entries: {} };
      const pending = PendingWorkingMemoryMutationSchema.parse({
      proposalId: 'wmproposal_01JNZQ4A9B8C7D6E5F4G3H2J1S',
      householdId,
      conversationId,
      speakerPrincipalRef: 'telegram:user:1',
      mutation: {
        operation: 'create',
        entryId: 'wme_01JNZQ4A9B8C7D6E5F4G3H2J1S',
        entry: {
          kind: 'communication_preference',
          summary: 'Use concise replies.',
          scope: 'household',
          value: { detail: 'concise' },
        },
      },
      basedOnRevision: workingMemoryRevision(emptyDocument),
      createdAt: '2026-08-03T10:00:00.000Z',
      expiresAt: '2026-08-03T10:15:00.000Z',
      });
      const interaction = await repository.create(PendingInteractionSchemaV1.parse({
      schemaName: 'pending-interaction',
      schemaVersion: 1,
      interactionId: pending.proposalId,
      kind: 'working_memory_confirmation',
      householdId,
      conversationId,
      speakerPrincipalRef: 'telegram:user:1',
      pendingWorkingMemoryMutation: pending,
      status: 'pending',
      version: 0,
      createdAt: pending.createdAt,
      expiresAt: pending.expiresAt,
      }));
      const claimed = await repository.claim({
      householdId,
      interactionId: interaction.interactionId,
      externalMessageId: 'crash-approval',
      decision: 'approve',
      expectedVersion: interaction.version,
      });
      if (claimed.kind !== 'claimed') throw new Error('Expected the crash fixture to be claimed.');

      const applyWorkingMemoryMutation = vi.spyOn(sessionMemory, 'applyWorkingMemoryMutation');
      await expect(sessionMemory.applyWorkingMemoryMutation({
      threadId: conversationId,
      resourceId: householdId,
      principalRef: 'telegram:user:1',
      basedOnRevision: pending.basedOnRevision,
      mutation: pending.mutation,
      })).resolves.toMatchObject({ status: 'succeeded' });

      const finalizePendingWorkingMemoryResolution = vi.fn(async (input: {
      status: 'applied' | 'rejected' | 'expired' | 'stale' | 'failed';
      code: string;
      }) => ({
        status: input.status,
        code: input.code,
        response: response('The preference was already saved and verified after recovery.'),
      }));
      const runNormalTurn = vi.fn(async () => response('Handled as a normal turn.'));
      const recovered = await runConversationTurn({
      pendingInteractions: repository,
      orchestrator: {
        classifyPendingWorkingMemoryInput: vi.fn(),
        resolvePendingWorkingMemoryMutation: vi.fn(),
        finalizePendingWorkingMemoryResolution,
      } as never,
      runNormalTurn,
      sessionMemory,
      }, { message: message('yes', 'crash-approval') });

      expect(recovered.body).toContain('already saved and verified');
      expect(runNormalTurn).not.toHaveBeenCalled();
      expect(finalizePendingWorkingMemoryResolution).toHaveBeenCalledWith(expect.objectContaining({
      status: 'applied',
      code: 'working_memory_mutation_recovered',
      }));
      expect(applyWorkingMemoryMutation).toHaveBeenCalledOnce();
      await expect(repository.findById({ householdId, interactionId: interaction.interactionId }))
        .resolves.toMatchObject({
        status: 'applied',
        resolutionExternalMessageId: 'crash-approval',
        resolutionCode: 'working_memory_mutation_recovered',
        });
      const readback = await sessionMemory.inspectWorkingMemory({
      threadId: conversationId,
      resourceId: householdId,
      principalRef: 'telegram:user:1',
      });
      expect(readback.status).toBe('succeeded');
      if (readback.status === 'succeeded') {
        expect(workingMemoryMutationEffectIsPresent({
          document: readback.document,
          mutation: pending.mutation,
        })).toBe(true);
      }
    } finally {
      await sessionMemory.close().catch(() => undefined);
      await pool.end().catch(() => undefined);
    }
  });

  it('does not resume a context-switched clarification when approving the original proposal', async () => {
    context = await createPostgresTestContext('orchestrator_loop_context_switch');
    const pool = new Pool({ connectionString: context.roleUrls.operations });
    await pool.query(
      `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
       VALUES ($1, 'USD', 'UTC')`,
      [householdId],
    );
    const repository = new PostgresPendingInteractionRepository(pool);
    const proposal = PendingWorkingMemoryMutationSchema.parse({
      proposalId: 'wmproposal_01JNZQ4A9B8C7D6E5F4G3H2J1R',
      householdId,
      conversationId,
      speakerPrincipalRef: 'telegram:user:1',
      mutation: {
        operation: 'create',
        entryId: 'wme_01JNZQ4A9B8C7D6E5F4G3H2J1R',
        entry: {
          kind: 'goal',
          summary: 'Save for a new car.',
          scope: 'household',
          value: { goal: 'new car' },
        },
      },
      basedOnRevision: 'a'.repeat(64),
      createdAt: '2026-08-03T10:00:00.000Z',
      expiresAt: '2026-08-03T10:15:00.000Z',
    });
    const runTurn = vi.fn()
      .mockResolvedValueOnce({
        kind: 'ask-user' as const,
        response: response('I can save the new-car goal. Would you like me to proceed?'),
        pendingWorkingMemoryMutation: proposal,
      })
      .mockResolvedValueOnce({
        kind: 'ask-user' as const,
        response: response('Which account should I use for that request?'),
      });
    const resolvePendingWorkingMemoryMutation = vi.fn(async () => ({
      status: 'applied' as const,
      code: 'working_memory_mutation_succeeded',
      response: response('The new-car goal was saved and verified.'),
    }));
    const classifyPendingWorkingMemoryInput = vi.fn(async ({ message: inbound }: { message: InboundChannelMessageV1 }) =>
      inbound.body === 'yes' ? 'approve' as const : 'new_intent' as const);
    const orchestrator = {
      runTurn,
      classifyPendingWorkingMemoryInput,
      resolvePendingWorkingMemoryMutation,
      finalizePendingWorkingMemoryResolution: vi.fn(),
      synthesizePendingWorkingMemoryConfirmation: vi.fn(),
    };
    const localMastra = createMastra(
      context.roleUrls.memory,
      {},
      [],
      { 'orchestrator-loop': createOrchestratorLoopWorkflow(orchestrator as never, repository) },
    );
    try {
      await runOrchestratorLoop({
        workflow: localMastra.getWorkflow('orchestrator-loop'),
        message: message('Please remember that we are saving for a new car.', 'switch-1'),
        pendingInteractions: repository,
        orchestrator: orchestrator as never,
      });
      const clarification = await runOrchestratorLoop({
        workflow: localMastra.getWorkflow('orchestrator-loop'),
        message: message('Add a $10 burger transaction.', 'switch-2'),
        pendingInteractions: repository,
        orchestrator: orchestrator as never,
      });
      expect(clarification.body).toContain('Which account');
      await expect(repository.findOpen({
        householdId,
        conversationId,
        speakerPrincipalRef: 'telegram:user:1',
      })).resolves.toMatchObject({ status: 'pending' });

      const approved = await runOrchestratorLoop({
        workflow: localMastra.getWorkflow('orchestrator-loop'),
        message: message('yes', 'switch-3'),
        pendingInteractions: repository,
        orchestrator: orchestrator as never,
      });
      expect(approved.body).toContain('new-car goal was saved');
      expect(runTurn).toHaveBeenCalledTimes(2);
      expect(resolvePendingWorkingMemoryMutation).toHaveBeenCalledOnce();
      await expect(repository.findById({ householdId, interactionId: proposal.proposalId }))
        .resolves.toMatchObject({ status: 'applied', resolutionExternalMessageId: 'switch-3' });
    } finally {
      await localMastra.getStorage()?.close?.();
      await pool.end();
    }
  });

  it('suspends on clarification and resumes on the next inbound message for the same conversation', async () => {
    context = await createPostgresTestContext('orchestrator_loop');
    const orchestrator = {
      runTurn: vi.fn()
        .mockResolvedValueOnce({ kind: 'ask-user', response: response('Which account was used to pay?') })
        .mockResolvedValueOnce({ kind: 'final', response: response('Recorded the burger transaction.') }),
    };
    mastra = createMastra(
      context.roleUrls.memory,
      {},
      [],
      { 'orchestrator-loop': createOrchestratorLoopWorkflow(orchestrator as never) },
    );
    const [route] = createRuntimeRoutes({
      config: {
        nodeEnv: 'test',
        host: '127.0.0.1',
        port: 4111,
        turnDeadlineMs: 60_000,
        database: { poolUrls: {} } as never,
        models: {
          orchestrator: { id: 'openai/gpt-5', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
          lead: { id: 'openai/gpt-5', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
          maker: { id: 'openai/gpt-5-mini', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
          checker: { id: 'openai/gpt-5', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
          research: { id: 'openai/gpt-5', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
        },
      },
      agentSystem: { teams: [] } as never,
      teamRuntime: {
        runTeamLead: vi.fn(),
        resumePendingMutation: async () => { throw new Error('Unexpected mutation resume'); },
        cancelPendingMutation: async () => { throw new Error('Unexpected mutation cancellation'); },
      },
      orchestrator: orchestrator as never,
      getMastra: () => mastra!,
    });
    if (route === undefined || !('handler' in route)) throw new Error('Expected runtime route handler');

    const first = await route.handler({
      req: { json: async () => message('add $10 of buying a burger', 'message-1') },
      json: (body: unknown) => Response.json(body),
    } as never, async () => undefined);
    const second = await route.handler({
      req: { json: async () => message('From checking account.', 'message-2') },
      json: (body: unknown) => Response.json(body),
    } as never, async () => undefined);

    await expect(first.json()).resolves.toMatchObject({ body: 'Which account was used to pay?' });
    await expect(second.json()).resolves.toMatchObject({ body: 'Recorded the burger transaction.' });
    expect(orchestrator.runTurn.mock.calls.map(([input]) => input.message.body)).toEqual([
      'add $10 of buying a burger',
      'From checking account.',
    ]);
  });

  it('restores the exact pending mutation snapshot after a Mastra restart', async () => {
    context = await createPostgresTestContext('orchestrator_loop_mutation');
    const orchestrator = {
      runTurn: vi.fn().mockResolvedValue({
        kind: 'ask-user',
        response: response('I’ll add Bank ABC as an IDR asset account with a normal debit balance. Would you like me to proceed?'),
        pendingMutation: pendingTeamResult,
      }),
      resolvePendingMutation: vi.fn().mockResolvedValue({
        kind: 'final',
        response: response('Bank ABC was added and verified.'),
      }),
    };
    const firstMastra = createMastra(
      context.roleUrls.memory,
      {},
      [],
      { 'orchestrator-loop': createOrchestratorLoopWorkflow(orchestrator as never) },
    );
    await runInbound(firstMastra, message('Add Bank ABC as an IDR asset account.', 'message-1'));
    await firstMastra.getStorage()?.close?.();

    mastra = createMastra(
      context.roleUrls.memory,
      {},
      [],
      { 'orchestrator-loop': createOrchestratorLoopWorkflow(orchestrator as never) },
    );
    const resumed = await runInbound(mastra, message('go ahead', 'message-2'));

    expect(orchestrator.resolvePendingMutation).toHaveBeenCalledWith(expect.objectContaining({
      pending: expect.objectContaining({
        effect: expect.objectContaining({
          state: 'awaiting_confirmation',
          command: pendingEffectFixture.command,
        }),
      }),
    }));
    expect(resumed).toMatchObject({ body: 'Bank ABC was added and verified.' });
  });
});

async function runInbound(
  activeMastra: ReturnType<typeof createMastra>,
  inbound: InboundChannelMessageV1,
) {
  return runOrchestratorLoop({
    workflow: activeMastra.getWorkflow('orchestrator-loop'),
    message: inbound,
  });
}
