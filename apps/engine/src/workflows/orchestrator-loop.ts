import { createStep, createWorkflow, type Workflow } from '@mastra/core/workflows';
import { z } from 'zod';
import {
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  PendingInteractionSchemaV1,
  PendingWorkingMemoryMutationSchema,
  PlusOneError,
  TeamResultEnvelopeSchemaV2,
  type InboundChannelMessageV1,
  type OrchestratorFinalResponseV1,
  type PendingInteractionV1,
  type PendingWorkingMemoryMutation,
} from '@plus-one/contracts';
import type {
  OrchestratorAgent,
  OrchestratorTurnResult,
} from '../agents/orchestrator.js';
import type { PendingInteractionRepository } from '@plus-one/database';
import {
  TransactionCaptureContinuationSchemaV1,
} from '../accounting/transaction-capture-continuation.js';
import { BudgetingContinuationSchemaV1 } from '../budgeting/budgeting-continuation.js';
import type { OrchestratorSessionMemoryPort } from '../memory/orchestrator-session-memory.js';
import { runConversationTurn } from './conversation-turn-router.js';

export const ORCHESTRATOR_LOOP_WORKFLOW_ID = 'orchestrator-loop';
export const ORCHESTRATOR_LOOP_STEP_ID = 'orchestrator-turn';

type OrchestratorLoopWorkflow = Workflow;

export const OrchestratorSuspendPayloadSchemaV1 = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('clarification'),
    response: OrchestratorFinalResponseSchemaV1,
    transactionContinuation: TransactionCaptureContinuationSchemaV1.optional(),
    budgetingContinuation: BudgetingContinuationSchemaV1.optional(),
  }).strict(),
  z.object({
    kind: z.literal('mutation_confirmation'),
    response: OrchestratorFinalResponseSchemaV1,
    pendingMutation: TeamResultEnvelopeSchemaV2,
    transactionContinuation: TransactionCaptureContinuationSchemaV1.optional(),
  }).strict(),
  z.object({
    kind: z.literal('working_memory_confirmation'),
    response: OrchestratorFinalResponseSchemaV1,
    pendingWorkingMemoryMutation: PendingWorkingMemoryMutationSchema,
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
  orchestrator?: Pick<
    OrchestratorAgent,
    | 'runTurn'
    | 'resolvePendingMutation'
    | 'resolvePendingWorkingMemoryMutation'
    | 'classifyPendingWorkingMemoryInput'
    | 'finalizePendingWorkingMemoryResolution'
    | 'synthesizePendingWorkingMemoryConfirmation'
  >,
  pendingInteractions?: PendingInteractionRepository,
  sessionMemory?: OrchestratorSessionMemoryPort,
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
      if (suspended?.kind === 'working_memory_confirmation' && pendingInteractions !== undefined) {
        await persistPendingWorkingMemoryInteraction(pendingInteractions, suspended.pendingWorkingMemoryMutation);
        return abortable(runConversationTurn({
          pendingInteractions,
          orchestrator,
          ...(sessionMemory === undefined ? {} : { sessionMemory }),
          runNormalTurn: async ({ message: normalMessage, signal }) => {
            const normalResult = await abortable(orchestrator.runTurn({
              message: normalMessage,
              ...optionalSignal(signal),
            }), signal) as OrchestratorTurnResult;
            if (normalResult.kind === 'ask-user' && normalResult.pendingWorkingMemoryMutation !== undefined) {
              const persisted = await persistPendingWorkingMemoryInteraction(
                pendingInteractions,
                normalResult.pendingWorkingMemoryMutation,
              );
              if (persisted.interactionId !== normalResult.pendingWorkingMemoryMutation.proposalId) {
                return orchestrator.synthesizePendingWorkingMemoryConfirmation({
                  message: normalMessage,
                  pending: persisted.pendingWorkingMemoryMutation,
                  ...optionalSignal(signal),
                });
              }
            }
            return normalResult.response;
          },
        }, { message, ...optionalSignal(abortSignal) }), abortSignal);
      }
      let result: OrchestratorTurnResult;
      if (suspended?.kind === 'mutation_confirmation') {
        result = await abortable(orchestrator.resolvePendingMutation({
          message,
          pending: suspended.pendingMutation,
          ...(suspended.transactionContinuation === undefined
            ? {}
            : { transactionContinuation: suspended.transactionContinuation }),
          ...optionalSignal(abortSignal),
        }), abortSignal);
      } else if (suspended?.kind === 'working_memory_confirmation') {
        const disposition = await orchestrator.classifyPendingWorkingMemoryInput({
          message,
          pending: suspended.pendingWorkingMemoryMutation,
          ...optionalSignal(abortSignal),
        });
        if (disposition === 'new_intent') {
          result = await abortable(orchestrator.runTurn({
            message,
            ...optionalSignal(abortSignal),
          }), abortSignal) as OrchestratorTurnResult;
        } else {
          const resolution = await abortable(orchestrator.resolvePendingWorkingMemoryMutation({
            message,
            pending: suspended.pendingWorkingMemoryMutation,
            decision: disposition,
            ...optionalSignal(abortSignal),
          }), abortSignal);
          return resolution.response;
        }
      } else {
        result = await abortable(orchestrator.runTurn({
          message,
            ...(suspended?.transactionContinuation === undefined
              ? {}
              : { transactionContinuation: suspended.transactionContinuation }),
            ...(suspended?.budgetingContinuation === undefined
              ? {}
              : { budgetingContinuation: suspended.budgetingContinuation }),
          ...optionalSignal(abortSignal),
        }), abortSignal) as OrchestratorTurnResult;
      }
      if (result.kind === 'ask-user') {
        if (result.pendingMutation !== undefined && result.pendingWorkingMemoryMutation !== undefined) {
          throw new Error('Orchestrator returned multiple pending mutation types.');
        }
        if (result.pendingWorkingMemoryMutation !== undefined) {
          if (pendingInteractions !== undefined) {
            const persisted = await persistPendingWorkingMemoryInteraction(
              pendingInteractions,
              result.pendingWorkingMemoryMutation,
            );
            if (persisted.interactionId !== result.pendingWorkingMemoryMutation.proposalId) {
              return orchestrator.synthesizePendingWorkingMemoryConfirmation({
                message,
                pending: persisted.pendingWorkingMemoryMutation,
                ...optionalSignal(abortSignal),
              });
            }
            return result.response;
          }
          return suspend({
            kind: 'working_memory_confirmation',
            response: result.response,
            pendingWorkingMemoryMutation: result.pendingWorkingMemoryMutation,
          });
        }
        return suspend(result.pendingMutation === undefined
          ? {
              kind: 'clarification',
              response: result.response,
              ...(result.transactionContinuation === undefined
                ? {}
                : { transactionContinuation: result.transactionContinuation }),
              ...(result.budgetingContinuation === undefined
                ? {}
                : { budgetingContinuation: result.budgetingContinuation }),
            }
          : {
              kind: 'mutation_confirmation',
              response: result.response,
              pendingMutation: result.pendingMutation,
              ...(result.transactionContinuation === undefined
                ? {}
                : { transactionContinuation: result.transactionContinuation }),
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

async function persistPendingWorkingMemoryInteraction(
  repository: PendingInteractionRepository,
  pending: PendingWorkingMemoryMutation,
): Promise<PendingInteractionV1> {
  const interaction = PendingInteractionSchemaV1.parse({
    schemaName: 'pending-interaction',
    schemaVersion: 1,
    interactionId: pending.proposalId,
    kind: 'working_memory_confirmation',
    householdId: pending.householdId,
    conversationId: pending.conversationId,
    speakerPrincipalRef: pending.speakerPrincipalRef,
    pendingWorkingMemoryMutation: pending,
    status: 'pending',
    version: 0,
    createdAt: pending.createdAt,
    expiresAt: pending.expiresAt,
  });
  try {
    return await repository.create(interaction);
  } catch (error) {
    if (!(error instanceof PlusOneError) || error.code !== 'pending_interaction_scope_conflict') {
      throw error;
    }
    const existing = await repository.findOpen({
      householdId: pending.householdId,
      conversationId: pending.conversationId,
      speakerPrincipalRef: pending.speakerPrincipalRef,
    });
    if (existing === undefined) throw error;
    return existing;
  }
}

export async function runOrchestratorLoop(input: {
  workflow: OrchestratorLoopWorkflow;
  message: InboundChannelMessageV1;
  signal?: AbortSignal;
  pendingInteractions?: PendingInteractionRepository;
  orchestrator?: Pick<
    OrchestratorAgent,
    | 'classifyPendingWorkingMemoryInput'
    | 'resolvePendingWorkingMemoryMutation'
    | 'finalizePendingWorkingMemoryResolution'
  >;
  sessionMemory?: OrchestratorSessionMemoryPort;
}): Promise<OrchestratorFinalResponseV1> {
  if (input.pendingInteractions !== undefined && input.orchestrator !== undefined) {
    return runConversationTurn({
      pendingInteractions: input.pendingInteractions,
      orchestrator: input.orchestrator,
      ...(input.sessionMemory === undefined ? {} : { sessionMemory: input.sessionMemory }),
      runNormalTurn: ({ message, signal }) => executeOrchestratorLoop({
        workflow: input.workflow,
        message,
        ...optionalSignal(signal),
      }),
    }, input);
  }
  return executeOrchestratorLoop(input);
}

async function executeOrchestratorLoop(input: {
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
    if (isRecord(result) && 'error' in result && result.error !== undefined) {
      throw result.error;
    }
    throw new Error(`Unexpected orchestrator loop result: ${(result as { status?: string }).status ?? 'unknown'}`);
  } finally {
    input.signal?.removeEventListener('abort', onAbort);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Orchestrator workflow aborted.', 'AbortError');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalSignal(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
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
