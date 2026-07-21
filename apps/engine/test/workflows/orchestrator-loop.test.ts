import { describe, expect, it, vi } from 'vitest';
import { InboundChannelMessageSchemaV1, OrchestratorFinalResponseSchemaV1 } from '@plus-one/contracts';
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
