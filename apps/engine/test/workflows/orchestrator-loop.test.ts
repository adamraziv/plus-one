import { describe, expect, it, vi } from 'vitest';
import {
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  PendingInteractionSchemaV1,
  PendingWorkingMemoryMutationSchema,
  PlusOneError,
  type PendingInteractionV1,
} from '@plus-one/contracts';
import { pendingChartResultFixture as pendingTeamResult } from '../helpers/pending-chart-result.js';
import {
  createOrchestratorLoopWorkflow,
  ORCHESTRATOR_LOOP_STEP_ID,
  runOrchestratorLoop,
} from '../../src/workflows/orchestrator-loop.js';

const message = InboundChannelMessageSchemaV1.parse({
  schemaName: 'inbound-channel-message',
  schemaVersion: 1,
  conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  channel: 'telegram',
  externalMessageId: 'telegram:42:100',
  receivedAt: '2026-07-06T00:00:00.000Z',
  speaker: { principalRef: 'telegram:user:42' },
  body: 'What did we spend this month?',
  attachments: [],
  metadata: { destination: { chatId: 'telegram-chat-42' } },
});

function response(body: string) {
  return OrchestratorFinalResponseSchemaV1.parse({
    schemaName: 'orchestrator-final-response',
    schemaVersion: 1,
    responseId: `response_${body.replace(/[^a-z]+/gi, '_').slice(0, 80)}`,
    householdId: message.householdId,
    conversationId: message.conversationId,
    body,
    policyBoundary: 'personalized_finance',
    citations: [{ label: 'orchestrator:test', sourceRef: 'test' }],
    assumptions: [],
    freshness: ['current invocation'],
    disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
    unsupportedCapabilities: [],
    recommendationActions: [],
    delivery: { channel: 'telegram', destination: { chatId: 'telegram-chat-42' }, format: 'mrkdwn' },
    responseHash: 'a'.repeat(64),
    createdAt: '2026-07-06T00:00:00.000Z',
  });
}

const confirmationResponse = response('I’ll add Bank ABC as an IDR asset account. Would you like me to proceed?');
const persistedResponse = response('Bank ABC was added and verified.');
const abortSignal = new AbortController().signal;
const pendingWorkingMemoryMutation = PendingWorkingMemoryMutationSchema.parse({
  proposalId: 'wmproposal_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  householdId: message.householdId,
  conversationId: message.conversationId,
  speakerPrincipalRef: message.speaker.principalRef,
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
});

describe('orchestrator workflow loop', () => {
  it('passes Mastra step abort signals into the orchestrator turn', async () => {
    const finalResponse = OrchestratorFinalResponseSchemaV1.parse({
      ...response('Done.'),
      policyBoundary: 'informational_only',
      citations: [{ label: 'orchestrator-policy', sourceRef: 'runtime-instructions' }],
    });
    const runTurn = vi.fn(async () => ({ kind: 'final' as const, response: finalResponse }));
    const workflow = createOrchestratorLoopWorkflow({ runTurn } as never);
    const abortSignal = new AbortController().signal;

    await workflow.steps[ORCHESTRATOR_LOOP_STEP_ID]?.execute({
      inputData: message,
      resumeData: undefined,
      suspend: vi.fn(),
      abortSignal,
    } as never);

    expect(runTurn).toHaveBeenCalledWith({ message, signal: abortSignal });
  });

  it('stores a pending mutation in suspend data and resolves it on the next message', async () => {
    const suspend = vi.fn();
    const orchestrator = {
      runTurn: vi.fn().mockResolvedValue({
        kind: 'ask-user',
        response: confirmationResponse,
        pendingMutation: pendingTeamResult,
      }),
      resolvePendingMutation: vi.fn().mockResolvedValue({
        kind: 'final',
        response: persistedResponse,
      }),
    };
    const workflow = createOrchestratorLoopWorkflow(orchestrator as never);
    const step = workflow.steps[ORCHESTRATOR_LOOP_STEP_ID]!;

    await step.execute({ inputData: message, suspend, abortSignal } as never);
    expect(suspend).toHaveBeenCalledWith({
      kind: 'mutation_confirmation',
      response: confirmationResponse,
      pendingMutation: pendingTeamResult,
    });

    const confirmationMessage = InboundChannelMessageSchemaV1.parse({
      ...message,
      externalMessageId: 'telegram-confirmation-2',
      body: 'go ahead',
    });
    await step.execute({
      inputData: message,
      resumeData: confirmationMessage,
      suspendData: suspend.mock.calls[0]![0],
      suspend,
      abortSignal,
    } as never);
    expect(orchestrator.resolvePendingMutation).toHaveBeenCalledWith(expect.objectContaining({
      pending: pendingTeamResult,
    }));
  });

  it('persists a Working Memory proposal without suspending the workflow', async () => {
    const suspend = vi.fn();
    const pendingInteractions = pendingInteractionRepository();
    const orchestrator = {
      runTurn: vi.fn().mockResolvedValue({
        kind: 'ask-user',
        response: response('I can save that goal. Would you like me to proceed?'),
        pendingWorkingMemoryMutation,
      }),
      resolvePendingMutation: vi.fn(),
      resolvePendingWorkingMemoryMutation: vi.fn().mockResolvedValue({
        status: 'applied',
        code: 'working_memory_mutation_succeeded',
        response: persistedResponse,
      }),
      classifyPendingWorkingMemoryInput: vi.fn(),
      finalizePendingWorkingMemoryResolution: vi.fn(),
    };
    const workflow = createOrchestratorLoopWorkflow(orchestrator as never, pendingInteractions as never);
    const step = workflow.steps[ORCHESTRATOR_LOOP_STEP_ID]!;

    await step.execute({ inputData: message, suspend, abortSignal } as never);
    expect(suspend).not.toHaveBeenCalled();
    expect(pendingInteractions.create).toHaveBeenCalledWith(expect.objectContaining({
      interactionId: pendingWorkingMemoryMutation.proposalId,
      status: 'pending',
      pendingWorkingMemoryMutation,
    }));
  });

  it('reuses the open interaction after an asynchronous scope conflict', async () => {
    const pendingInteractions = pendingInteractionRepository();
    const conflict = new PlusOneError({
      category: 'serialization_conflict',
      code: 'pending_interaction_scope_conflict',
      message: 'An open Working Memory confirmation already exists.',
      retry: 'after_state_resolution',
      receiptLookupRequired: true,
    });
    pendingInteractions.create.mockRejectedValueOnce(conflict);
    pendingInteractions.findOpen.mockResolvedValueOnce(pendingInteraction());
    const orchestrator = {
      runTurn: vi.fn().mockResolvedValue({
        kind: 'ask-user',
        response: response('I can save that goal. Would you like me to proceed?'),
        pendingWorkingMemoryMutation,
      }),
      synthesizePendingWorkingMemoryConfirmation: vi.fn(),
    };
    const workflow = createOrchestratorLoopWorkflow(orchestrator as never, pendingInteractions as never);

    await workflow.steps[ORCHESTRATOR_LOOP_STEP_ID]?.execute({
      inputData: message,
      suspend: vi.fn(),
      abortSignal,
    } as never);

    expect(pendingInteractions.findOpen).toHaveBeenCalledWith({
      householdId: pendingWorkingMemoryMutation.householdId,
      conversationId: pendingWorkingMemoryMutation.conversationId,
      speakerPrincipalRef: pendingWorkingMemoryMutation.speakerPrincipalRef,
    });
    expect(orchestrator.synthesizePendingWorkingMemoryConfirmation).not.toHaveBeenCalled();
  });

  it('propagates non-conflict persistence failures without looking for an open interaction', async () => {
    const pendingInteractions = pendingInteractionRepository();
    const failure = new Error('database unavailable');
    pendingInteractions.create.mockRejectedValueOnce(failure);
    const orchestrator = {
      runTurn: vi.fn().mockResolvedValue({
        kind: 'ask-user',
        response: response('I can save that goal. Would you like me to proceed?'),
        pendingWorkingMemoryMutation,
      }),
    };
    const workflow = createOrchestratorLoopWorkflow(orchestrator as never, pendingInteractions as never);

    await expect(workflow.steps[ORCHESTRATOR_LOOP_STEP_ID]?.execute({
      inputData: message,
      suspend: vi.fn(),
      abortSignal,
    } as never)).rejects.toBe(failure);
    expect(pendingInteractions.findOpen).not.toHaveBeenCalled();
  });

  it('rethrows a scope conflict when the open interaction cannot be recovered', async () => {
    const pendingInteractions = pendingInteractionRepository();
    const conflict = new PlusOneError({
      category: 'serialization_conflict',
      code: 'pending_interaction_scope_conflict',
      message: 'An open Working Memory confirmation already exists.',
      retry: 'after_state_resolution',
      receiptLookupRequired: true,
    });
    pendingInteractions.create.mockRejectedValueOnce(conflict);
    pendingInteractions.findOpen.mockResolvedValueOnce(undefined);
    const orchestrator = {
      runTurn: vi.fn().mockResolvedValue({
        kind: 'ask-user',
        response: response('I can save that goal. Would you like me to proceed?'),
        pendingWorkingMemoryMutation,
      }),
    };
    const workflow = createOrchestratorLoopWorkflow(orchestrator as never, pendingInteractions as never);

    await expect(workflow.steps[ORCHESTRATOR_LOOP_STEP_ID]?.execute({
      inputData: message,
      suspend: vi.fn(),
      abortSignal,
    } as never)).rejects.toBe(conflict);
  });

  it('imports a legacy Working Memory suspension and resolves it through the typed router', async () => {
    const suspend = vi.fn();
    const pendingInteractions = pendingInteractionRepository();
    const orchestrator = {
      runTurn: vi.fn(),
      resolvePendingMutation: vi.fn(),
      classifyPendingWorkingMemoryInput: vi.fn().mockResolvedValue('approve'),
      resolvePendingWorkingMemoryMutation: vi.fn().mockResolvedValue({
        status: 'applied',
        code: 'working_memory_mutation_succeeded',
        response: persistedResponse,
      }),
      finalizePendingWorkingMemoryResolution: vi.fn(),
    };
    const workflow = createOrchestratorLoopWorkflow(orchestrator as never, pendingInteractions as never);
    const step = workflow.steps[ORCHESTRATOR_LOOP_STEP_ID]!;

    const confirmationMessage = InboundChannelMessageSchemaV1.parse({
      ...message,
      externalMessageId: 'telegram-working-memory-confirmation-2',
      body: 'yes',
    });
    await step.execute({
      inputData: message,
      resumeData: confirmationMessage,
      suspendData: {
        kind: 'working_memory_confirmation',
        response: response('I can save that goal. Would you like me to proceed?'),
        pendingWorkingMemoryMutation,
      },
      suspend,
      abortSignal,
    } as never);
    expect(orchestrator.resolvePendingWorkingMemoryMutation).toHaveBeenCalledWith({
      message: confirmationMessage,
      pending: pendingWorkingMemoryMutation,
      decision: 'approve',
      signal: abortSignal,
    });
    expect(suspend).not.toHaveBeenCalled();
    expect((await pendingInteractions.findOpen({
      householdId: message.householdId,
      conversationId: message.conversationId,
      speakerPrincipalRef: message.speaker.principalRef,
    }))).toBeUndefined();
  });

  it('persists transaction continuation through clarification suspension and resume', async () => {
    const suspend = vi.fn();
    const transactionContinuation = {
      schemaName: 'transaction-capture-continuation' as const,
      schemaVersion: 1 as const,
      request: {
        schemaName: 'transaction-capture-request-draft' as const,
        schemaVersion: 1 as const,
        instruction: '50 USD in dining from test wallet',
        known: { amount: '50.00', currency: 'USD', paymentAccountName: 'test wallet' },
      },
    };
    const runTurn = vi.fn()
      .mockResolvedValueOnce({
        kind: 'ask-user' as const,
        response: response('Choose a category.'),
        transactionContinuation,
      })
      .mockResolvedValueOnce({ kind: 'final' as const, response: response('Recorded.') });
    const workflow = createOrchestratorLoopWorkflow({ runTurn } as never);
    const step = workflow.steps[ORCHESTRATOR_LOOP_STEP_ID]!;

    await step.execute({ inputData: message, suspend, abortSignal } as never);
    expect(suspend).toHaveBeenCalledWith({
      kind: 'clarification',
      response: response('Choose a category.'),
      transactionContinuation,
    });

    const clarification = suspend.mock.calls[0]![0];
    const next = InboundChannelMessageSchemaV1.parse({
      ...message,
      externalMessageId: 'telegram-category-2',
      body: 'Food',
    });
    await step.execute({
      inputData: message,
      resumeData: next,
      suspendData: clarification,
      suspend,
      abortSignal,
    } as never);

    expect(runTurn).toHaveBeenLastCalledWith(expect.objectContaining({
      message: next,
      transactionContinuation,
    }));
  });

  it('cancels the active workflow run when the channel signal aborts', async () => {
    const controller = new AbortController();
    const cancel = vi.fn(async () => undefined);
    const start = vi.fn(async () => {
      controller.abort(new DOMException('Timed out', 'TimeoutError'));
      return { status: 'failed' };
    });
    const workflow = workflowWithRun({ start, resume: vi.fn(), cancel });

    await expect(runOrchestratorLoop({ workflow, message, signal: controller.signal })).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('preserves the underlying workflow provider error for route classification', async () => {
    const providerError = Object.assign(new Error('Rate limit exceeded'), { statusCode: 429 });
    const workflow = workflowWithRun({
      start: vi.fn(async () => ({ status: 'failed', error: providerError })),
      resume: vi.fn(),
      cancel: vi.fn(async () => undefined),
    });

    await expect(runOrchestratorLoop({ workflow, message })).rejects.toBe(providerError);
  });

  it('does not start a workflow run when the channel signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('Timed out', 'TimeoutError'));
    const cancel = vi.fn(async () => undefined);
    const start = vi.fn(async () => ({ status: 'success', result: {} }));
    const createRun = vi.fn(async () => ({ start, resume: vi.fn(), cancel }));
    const workflow = {
      listWorkflowRuns: vi.fn(async () => ({ runs: [] })),
      createRun,
    } as never;

    await expect(runOrchestratorLoop({ workflow, message, signal: controller.signal })).rejects.toThrow('Timed out');
    expect(createRun).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});

function workflowWithRun(run: {
  start: (input: unknown) => Promise<unknown>;
  resume: (input: unknown) => Promise<unknown>;
  cancel: () => Promise<void>;
}) {
  return {
    listWorkflowRuns: vi.fn(async () => ({ runs: [] })),
    createRun: vi.fn(async () => run),
  } as never;
}

function pendingInteractionRepository() {
  let stored: PendingInteractionV1 | undefined;
  const repository = {
    create: vi.fn(async (candidate: PendingInteractionV1) => {
      stored = PendingInteractionSchemaV1.parse(candidate);
      return stored;
    }),
    findOpen: vi.fn(async (input: { householdId: string; conversationId: string; speakerPrincipalRef: string }) => {
      void input;
      return stored?.status === 'pending' || stored?.status === 'resolving' ? stored : undefined;
    }),
    findById: vi.fn(async () => stored),
    findByResolutionMessage: vi.fn(async ({ externalMessageId }: { externalMessageId: string }) =>
      stored?.resolutionExternalMessageId === externalMessageId ? stored : undefined),
    claim: vi.fn(async ({ externalMessageId }: { externalMessageId: string }) => {
      if (stored === undefined) throw new Error('missing interaction');
      stored = PendingInteractionSchemaV1.parse({
        ...stored,
        status: 'resolving',
        version: stored.version + 1,
        resolutionExternalMessageId: externalMessageId,
      });
      return { kind: 'claimed' as const, interaction: stored };
    }),
    complete: vi.fn(async (input: {
      status: 'applied' | 'rejected' | 'expired' | 'stale' | 'failed';
      resolutionCode: string;
      resolutionResponse: ReturnType<typeof response>;
      resolvedAt: string;
    }) => {
      if (stored === undefined) throw new Error('missing interaction');
      stored = PendingInteractionSchemaV1.parse({
        ...stored,
        status: input.status,
        version: stored.version + 1,
        resolutionCode: input.resolutionCode,
        resolutionResponse: input.resolutionResponse,
        resolvedAt: input.resolvedAt,
      });
      return stored;
    }),
  };
  return repository;
}

function pendingInteraction() {
  return PendingInteractionSchemaV1.parse({
    schemaName: 'pending-interaction',
    schemaVersion: 1,
    interactionId: pendingWorkingMemoryMutation.proposalId,
    kind: 'working_memory_confirmation',
    householdId: pendingWorkingMemoryMutation.householdId,
    conversationId: pendingWorkingMemoryMutation.conversationId,
    speakerPrincipalRef: pendingWorkingMemoryMutation.speakerPrincipalRef,
    pendingWorkingMemoryMutation,
    status: 'pending',
    version: 0,
    createdAt: pendingWorkingMemoryMutation.createdAt,
    expiresAt: pendingWorkingMemoryMutation.expiresAt,
  });
}
