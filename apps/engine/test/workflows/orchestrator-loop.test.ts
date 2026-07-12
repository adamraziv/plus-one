import { describe, expect, it, vi } from 'vitest';
import { InboundChannelMessageSchemaV1, OrchestratorFinalResponseSchemaV1 } from '@plus-one/contracts';
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

describe('orchestrator workflow loop', () => {
  it('passes Mastra step abort signals into the orchestrator turn', async () => {
    const response = OrchestratorFinalResponseSchemaV1.parse({
      schemaName: 'orchestrator-final-response',
      schemaVersion: 1,
      responseId: 'response_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      householdId: message.householdId,
      conversationId: message.conversationId,
      body: 'Done.',
      policyBoundary: 'informational_only',
      citations: [{ label: 'orchestrator-policy', sourceRef: 'runtime-instructions' }],
      assumptions: [],
      freshness: ['current invocation only'],
      disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
      unsupportedCapabilities: [],
      recommendationActions: [],
      delivery: { channel: 'telegram', destination: { chatId: 'telegram-chat-42' }, format: 'mrkdwn' },
      responseHash: 'a'.repeat(64),
      createdAt: '2026-07-06T00:00:00.000Z',
    });
    const runTurn = vi.fn(async () => ({ kind: 'final' as const, response }));
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
