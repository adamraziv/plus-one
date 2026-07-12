import { createStep, createWorkflow, type Workflow } from '@mastra/core/workflows';
import {
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  type InboundChannelMessageV1,
  type OrchestratorFinalResponseV1,
} from '@plus-one/contracts';
import type { OrchestratorAgent, OrchestratorTurnResult } from '../agents/orchestrator.js';

export const ORCHESTRATOR_LOOP_WORKFLOW_ID = 'orchestrator-loop';
export const ORCHESTRATOR_LOOP_STEP_ID = 'orchestrator-turn';

type OrchestratorLoopWorkflow = Workflow;

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
  return OrchestratorFinalResponseSchemaV1.parse(candidate);
}

export function createOrchestratorLoopWorkflow(
  orchestrator?: Pick<OrchestratorAgent, 'runTurn'>,
): OrchestratorLoopWorkflow {
  if (orchestrator === undefined) return placeholderWorkflow();

  const turnStep = createStep({
    id: ORCHESTRATOR_LOOP_STEP_ID,
    inputSchema: InboundChannelMessageSchemaV1,
    outputSchema: OrchestratorFinalResponseSchemaV1,
    suspendSchema: OrchestratorFinalResponseSchemaV1,
    resumeSchema: InboundChannelMessageSchemaV1,
    execute: async ({ inputData, resumeData, suspend, abortSignal }) => {
      const message = InboundChannelMessageSchemaV1.parse(resumeData ?? inputData);
      const result = await orchestrator.runTurn({ message, signal: abortSignal }) as OrchestratorTurnResult;
      if (result.kind === 'ask-user') return suspend(result.response);
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
  const suspendedRuns = await input.workflow.listWorkflowRuns({
    resourceId: input.message.conversationId,
    status: 'suspended',
  });
  const suspendedRun = [...suspendedRuns.runs]
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0];
  const run = await input.workflow.createRun({
    ...(suspendedRun === undefined ? {} : { runId: suspendedRun.runId }),
    resourceId: input.message.conversationId,
  });
  const onAbort = () => {
    void run.cancel().catch(() => undefined);
  };
  if (input.signal?.aborted) {
    await run.cancel();
  } else {
    input.signal?.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const result = suspendedRun === undefined
      ? await run.start({ inputData: input.message })
      : await run.resume({ step: ORCHESTRATOR_LOOP_STEP_ID, resumeData: input.message });

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
