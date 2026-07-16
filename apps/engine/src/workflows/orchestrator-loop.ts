import { createStep, createWorkflow, type Workflow } from '@mastra/core/workflows';
import { z } from 'zod';
import {
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  TeamResultEnvelopeSchemaV2,
  type InboundChannelMessageV1,
  type OrchestratorFinalResponseV1,
} from '@plus-one/contracts';
import type { OrchestratorAgent, OrchestratorTurnResult } from '../agents/orchestrator.js';

export const ORCHESTRATOR_LOOP_WORKFLOW_ID = 'orchestrator-loop';
export const ORCHESTRATOR_LOOP_STEP_ID = 'orchestrator-turn';

type OrchestratorLoopWorkflow = Workflow;

export const OrchestratorSuspendPayloadSchemaV1 = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('clarification'),
    response: OrchestratorFinalResponseSchemaV1,
  }).strict(),
  z.object({
    kind: z.literal('mutation_confirmation'),
    response: OrchestratorFinalResponseSchemaV1,
    pendingMutation: TeamResultEnvelopeSchemaV2,
  }).strict(),
]);

function placeholderWorkflow(): OrchestratorLoopWorkflow {
  return createWorkflow({
    id: ORCHESTRATOR_LOOP_WORKFLOW_ID,
    inputSchema: InboundChannelMessageSchemaV1,
    outputSchema: OrchestratorFinalResponseSchemaV1,
  }).commit();
}

function isSuspended(result: unknown): result is { status: 'suspended'; suspendPayload: unknown } {
  return typeof result === 'object' && result !== null && (result as { status?: unknown }).status === 'suspended';
}

function isSuccess(result: unknown): result is { status: 'success'; result: unknown } {
  return typeof result === 'object' && result !== null && (result as { status?: unknown }).status === 'success';
}

function finalResponseFromPayload(payload: unknown): OrchestratorFinalResponseV1 {
  const candidate = typeof payload === 'object'
    && payload !== null
    && ORCHESTRATOR_LOOP_STEP_ID in payload
    ? (payload as Record<string, unknown>)[ORCHESTRATOR_LOOP_STEP_ID]
    : payload;
  return OrchestratorSuspendPayloadSchemaV1.parse(candidate).response;
}

export function createOrchestratorLoopWorkflow(
  orchestrator?: Pick<OrchestratorAgent, 'runTurn' | 'resolvePendingMutation'>,
): OrchestratorLoopWorkflow {
  if (orchestrator === undefined) return placeholderWorkflow();

  const turnStep = createStep({
    id: ORCHESTRATOR_LOOP_STEP_ID,
    inputSchema: InboundChannelMessageSchemaV1,
    outputSchema: OrchestratorFinalResponseSchemaV1,
    suspendSchema: OrchestratorSuspendPayloadSchemaV1,
    resumeSchema: InboundChannelMessageSchemaV1,
    execute: async ({ inputData, resumeData, suspendData, suspend, abortSignal }) => {
      const message = InboundChannelMessageSchemaV1.parse(resumeData ?? inputData);
      const suspended = OrchestratorSuspendPayloadSchemaV1.optional().parse(suspendData);
      const result = suspended?.kind === 'mutation_confirmation'
        ? await abortable(orchestrator.resolvePendingMutation({
          message,
          pending: suspended.pendingMutation,
          signal: abortSignal,
        }), abortSignal)
        : await abortable(orchestrator.runTurn({ message, signal: abortSignal }), abortSignal) as OrchestratorTurnResult;
      if (result.kind === 'ask-user') {
        return suspend(result.pendingMutation === undefined
          ? { kind: 'clarification', response: result.response }
          : {
              kind: 'mutation_confirmation',
              response: result.response,
              pendingMutation: result.pendingMutation,
            });
      }
      return result.response;
    },
  });

  return createWorkflow({
    id: ORCHESTRATOR_LOOP_WORKFLOW_ID,
    inputSchema: InboundChannelMessageSchemaV1,
    outputSchema: OrchestratorFinalResponseSchemaV1,
  }).then(turnStep).commit();
}

export async function runOrchestratorLoop(input: {
  workflow: OrchestratorLoopWorkflow;
  message: InboundChannelMessageV1;
  signal?: AbortSignal;
}): Promise<OrchestratorFinalResponseV1> {
  throwIfAborted(input.signal);
  const suspendedRuns = await abortable(input.workflow.listWorkflowRuns({
    resourceId: input.message.conversationId,
    status: 'suspended',
  }), input.signal);
  const suspendedRun = [...suspendedRuns.runs]
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0];
  throwIfAborted(input.signal);
  const run = await abortable(input.workflow.createRun({
    ...(suspendedRun === undefined ? {} : { runId: suspendedRun.runId }),
    resourceId: input.message.conversationId,
  }), input.signal);
  const onAbort = () => {
    void run.cancel().catch(() => undefined);
  };
  if (input.signal?.aborted) {
    await run.cancel();
    throw input.signal.reason ?? new DOMException('Orchestrator workflow aborted.', 'AbortError');
  } else {
    input.signal?.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const result = suspendedRun === undefined
      ? await abortable(run.start({ inputData: input.message }), input.signal)
      : await abortable(run.resume({ step: ORCHESTRATOR_LOOP_STEP_ID, resumeData: input.message }), input.signal);

    if (isSuccess(result)) {
      return OrchestratorFinalResponseSchemaV1.parse(result.result);
    }
    if (isSuspended(result)) {
      return finalResponseFromPayload(result.suspendPayload);
    }
    throw new Error(`Unexpected orchestrator loop result: ${(result as { status?: string }).status ?? 'unknown'}`);
  } finally {
    input.signal?.removeEventListener('abort', onAbort);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Orchestrator workflow aborted.', 'AbortError');
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) throw signal.reason ?? new DOMException('Orchestrator workflow aborted.', 'AbortError');
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Orchestrator workflow aborted.', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
