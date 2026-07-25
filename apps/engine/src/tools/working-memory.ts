import { createTool } from '@mastra/core/tools';
import {
  PendingWorkingMemoryMutationSchema,
  WorkingMemoryInspectionToolResultSchema,
  WorkingMemoryMutationDraftSchema,
  WorkingMemoryMutationToolResultSchema,
  type FlexibleWorkingMemory,
  type ErrorCategoryV1,
  type InboundChannelMessageV1,
  type PendingWorkingMemoryMutation,
  type RetryDirectiveV1,
  type WorkingMemoryInspectionResult,
} from '@plus-one/contracts';
import { z } from 'zod';
import {
  createWorkingMemoryIdGenerator,
  resolveWorkingMemoryMutation,
  type WorkingMemoryIdGenerator,
} from '../memory/working-memory-document.js';
import type {
  OrchestratorSessionMemoryPort,
  WorkingMemoryMutationOperation,
  WorkingMemoryOperationOutcome,
} from '../memory/orchestrator-session-memory.js';

export type WorkingMemoryInspectionContext = WorkingMemoryInspectionResult & {
  document: FlexibleWorkingMemory;
};

export type ActiveWorkingMemoryInvocation = {
  message: Pick<InboundChannelMessageV1, 'conversationId' | 'householdId' | 'speaker'>;
  signal: AbortSignal;
  workingMemoryInspection?: WorkingMemoryInspectionContext;
};

const EmptyInputSchema = z.object({}).strict();

export function createInspectWorkingMemoryTool(input: {
  memory: OrchestratorSessionMemoryPort;
  getActiveInvocation(): ActiveWorkingMemoryInvocation | undefined;
  recordInspection(context: WorkingMemoryInspectionContext): void;
  recordOutcome?(outcome: WorkingMemoryOperationOutcome): void;
}) {
  return createTool({
    id: 'inspectWorkingMemory',
    description: 'Read current authorized Working Memory before every mutation.',
    inputSchema: EmptyInputSchema,
    outputSchema: WorkingMemoryInspectionToolResultSchema,
    execute: async () => {
      const active = input.getActiveInvocation();
      if (active === undefined) {
        const failure = inspectionFailure('working_memory_inspection_failed', 'runtime_failure', 'never');
        input.recordOutcome?.(failure.outcome);
        return failure.result;
      }
      if (active.signal.aborted) {
        throw active.signal.reason ?? new DOMException('Working Memory inspection aborted.', 'AbortError');
      }

      try {
        const result = await input.memory.inspectWorkingMemory({
          threadId: active.message.conversationId,
          resourceId: active.message.householdId,
          principalRef: active.message.speaker.principalRef,
        });
        input.recordOutcome?.(result.outcome);
        if (result.status === 'failed') return inspectionFailure(result.outcome.code, result.outcome.category ?? 'runtime_failure', result.outcome.retry ?? 'never').result;
        const context: WorkingMemoryInspectionContext = { ...result.inspection, document: result.document };
        input.recordInspection(context);
        return WorkingMemoryInspectionToolResultSchema.parse({
          status: 'succeeded',
          revision: result.inspection.revision,
          entries: result.inspection.entries,
        });
      } catch {
        const failure = inspectionFailure('working_memory_inspection_failed', 'runtime_failure', 'never');
        input.recordOutcome?.(failure.outcome);
        return failure.result;
      }
    },
  });
}

export function createMutateWorkingMemoryTool(input: {
  memory: OrchestratorSessionMemoryPort;
  ids?: WorkingMemoryIdGenerator;
  now(): Date;
  getActiveInvocation(): ActiveWorkingMemoryInvocation | undefined;
  recordPendingMutation(proposal: PendingWorkingMemoryMutation): void;
  recordOutcome?(outcome: WorkingMemoryOperationOutcome): void;
}) {
  const ids = input.ids ?? createWorkingMemoryIdGenerator();
  return createTool({
    id: 'mutateWorkingMemory',
    description: [
      'Create, replace, delete, or clear Working Memory.',
      'Call inspectWorkingMemory first in this same turn and pass its revision.',
      'Use an entryId returned by inspection for replace or delete.',
    ].join(' '),
    inputSchema: WorkingMemoryMutationDraftSchema,
    outputSchema: WorkingMemoryMutationToolResultSchema,
    execute: async (rawDraft) => {
      const parsedDraft = WorkingMemoryMutationDraftSchema.safeParse(rawDraft);
      const operation = parsedDraft.success ? parsedDraft.data.operation : 'create';
      if (!parsedDraft.success) return mutationFailureResult(operation, 'working_memory_mutation_invalid', 'validation_rejected', 'never');

      const active = input.getActiveInvocation();
      if (active === undefined) return mutationFailureResult(operation, 'working_memory_mutation_failed', 'runtime_failure', 'never');
      if (active.signal.aborted) {
        throw active.signal.reason ?? new DOMException('Working Memory mutation aborted.', 'AbortError');
      }
      const inspection = active.workingMemoryInspection;
      if (inspection === undefined || inspection.document === undefined) {
        return mutationFailureResult(operation, 'working_memory_inspection_required', 'validation_rejected', 'never');
      }
      if (parsedDraft.data.basedOnRevision !== inspection.revision) {
        return mutationFailureResult(operation, 'working_memory_revision_stale', 'serialization_conflict', 'after_state_resolution');
      }

      const resolved = resolveWorkingMemoryMutation({
        draft: parsedDraft.data,
        document: inspection.document,
        principalRef: active.message.speaker.principalRef,
        ids,
      });
      if (resolved.status === 'failed') {
        return mutationFailureResult(operation, resolved.code, mutationFailureCategory(resolved.code), 'never');
      }

      if (resolved.requiresConfirmation) {
        const validated = await input.memory.validateWorkingMemoryMutation({
          threadId: active.message.conversationId,
          resourceId: active.message.householdId,
          principalRef: active.message.speaker.principalRef,
          basedOnRevision: parsedDraft.data.basedOnRevision,
          mutation: resolved.mutation,
        });
        input.recordOutcome?.(validated.outcome);
        if (validated.status === 'failed') {
          return mutationFailureResult(operation, validated.code, validated.category, validated.retry);
        }
        const createdAt = input.now();
        const proposal = PendingWorkingMemoryMutationSchema.parse({
          proposalId: ids.nextProposalId(),
          householdId: active.message.householdId,
          conversationId: active.message.conversationId,
          speakerPrincipalRef: active.message.speaker.principalRef,
          mutation: resolved.mutation,
          basedOnRevision: parsedDraft.data.basedOnRevision,
          createdAt: createdAt.toISOString(),
          expiresAt: new Date(createdAt.getTime() + 15 * 60_000).toISOString(),
        });
        input.recordPendingMutation(proposal);
        return WorkingMemoryMutationToolResultSchema.parse({
          status: 'confirmation_required',
          operation,
          code: 'working_memory_confirmation_required',
        });
      }

      const applied = await input.memory.applyWorkingMemoryMutation({
        threadId: active.message.conversationId,
        resourceId: active.message.householdId,
        principalRef: active.message.speaker.principalRef,
        basedOnRevision: parsedDraft.data.basedOnRevision,
        mutation: resolved.mutation,
      });
      input.recordOutcome?.(applied.outcome);
      if (applied.status === 'failed') return mutationFailureResult(operation, applied.code, applied.category, applied.retry);
      return WorkingMemoryMutationToolResultSchema.parse({
        status: 'applied',
        operation,
        code: 'working_memory_mutation_succeeded',
      });
    },
  });
}

function inspectionFailure(
  code: string,
  category: ErrorCategoryV1,
  retry: RetryDirectiveV1,
) {
  const outcome: WorkingMemoryOperationOutcome = {
    operation: 'inspect',
    status: 'failed',
    code,
    category,
    retry,
  };
  return {
    outcome,
    result: WorkingMemoryInspectionToolResultSchema.parse({ status: 'failed', code, category, retry }),
  };
}

function mutationFailureResult(
  operation: WorkingMemoryMutationOperation,
  code: string,
  category: ErrorCategoryV1,
  retry: RetryDirectiveV1,
) {
  return WorkingMemoryMutationToolResultSchema.parse({
    status: 'rejected',
    operation,
    code,
    category,
    retry,
  });
}

function mutationFailureCategory(code: string): 'validation_rejected' | 'policy_rejected' {
  return code === 'working_memory_entry_forbidden' ? 'policy_rejected' : 'validation_rejected';
}
