import { createTool } from '@mastra/core/tools';
import {
  MAX_WORKING_MEMORY_TEXT_LENGTH,
  PendingWorkingMemoryMutationSchema,
  WorkingMemoryEntryIdSchema,
  WorkingMemoryKindSchema,
  WorkingMemoryCandidateInputSchema,
  WorkingMemoryCandidateToolResultSchema,
  WorkingMemoryViewResultSchema,
  WorkingMemoryReviewToolResultSchema,
  WorkingMemoryInspectionToolResultSchema,
  WorkingMemoryMutationDraftSchema,
  WorkingMemoryMutationToolResultSchema,
  WorkingMemoryValueSchema,
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
import { createWorkingMemoryCandidate } from '../memory/working-memory-candidates.js';
import { projectWorkingMemoryView } from '../memory/working-memory-prompt.js';
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
  requestedBy?: 'user' | 'scheduled_review';
};

const EmptyInputSchema = z.object({}).strict();

export const WorkingMemoryMutationToolInputSchema = z.object({
  operation: z.enum(['create', 'replace', 'delete', 'clear']),
  basedOnRevision: z.string().trim().min(1).max(128),
  entryId: WorkingMemoryEntryIdSchema.optional(),
  kind: WorkingMemoryKindSchema.optional(),
  summary: z.string().trim().min(1).max(MAX_WORKING_MEMORY_TEXT_LENGTH).optional(),
  scope: z.enum(['household', 'member']).optional(),
  value: WorkingMemoryValueSchema.optional(),
}).strip();

export function createInspectWorkingMemoryTool(input: {
  memory: OrchestratorSessionMemoryPort;
  getActiveInvocation(): ActiveWorkingMemoryInvocation | undefined;
  recordInspection(context: WorkingMemoryInspectionContext): void;
  recordOutcome?(outcome: WorkingMemoryOperationOutcome): void;
}) {
  return createTool({
    id: 'inspectWorkingMemory',
    description: 'Read current authorized Working Memory before every mutation or safe memory view.',
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

export function createViewWorkingMemoryTool(input: {
  memory: OrchestratorSessionMemoryPort;
  getActiveInvocation(): ActiveWorkingMemoryInvocation | undefined;
  recordInspection(context: WorkingMemoryInspectionContext): void;
  recordOutcome?(outcome: WorkingMemoryOperationOutcome): void;
}) {
  const inputSchema = z.object({ view: z.enum(['personal', 'household', 'all']) }).strict();
  return createTool({
    id: 'viewWorkingMemory',
    description: 'Show safe user-visible Working Memory summaries without internal IDs or revisions.',
    inputSchema,
    outputSchema: WorkingMemoryViewResultSchema,
    execute: async ({ view }) => {
      const active = input.getActiveInvocation();
      if (active === undefined) {
        const failure = viewFailure('working_memory_view_failed', 'runtime_failure', 'never');
        input.recordOutcome?.(failure.outcome);
        return failure.result;
      }
      if (active.signal.aborted) {
        throw active.signal.reason ?? new DOMException('Working Memory view aborted.', 'AbortError');
      }
      try {
        const result = await input.memory.inspectWorkingMemory({
          threadId: active.message.conversationId,
          resourceId: active.message.householdId,
          principalRef: active.message.speaker.principalRef,
        });
        input.recordOutcome?.(result.outcome);
        if (result.status === 'failed') {
          return viewFailure(result.outcome.code, result.outcome.category ?? 'runtime_failure', result.outcome.retry ?? 'never').result;
        }
        const context: WorkingMemoryInspectionContext = { ...result.inspection, document: result.document };
        input.recordInspection(context);
        return projectWorkingMemoryView({ inspection: result.inspection, view });
      } catch {
        const failure = viewFailure('working_memory_view_failed', 'runtime_failure', 'never');
        input.recordOutcome?.(failure.outcome);
        return failure.result;
      }
    },
  });
}

export function createReviewWorkingMemoryTool(input: {
  memory: OrchestratorSessionMemoryPort;
  now(): Date;
  getActiveInvocation(): ActiveWorkingMemoryInvocation | undefined;
  recordOutcome?(outcome: WorkingMemoryOperationOutcome): void;
}) {
  return createTool({
    id: 'reviewWorkingMemory',
    description: 'Review authorized Working Memory for deterministic duplicates, contradictions, scope mismatches, and stale facts without applying changes.',
    inputSchema: EmptyInputSchema,
    outputSchema: WorkingMemoryReviewToolResultSchema,
    execute: async () => {
      const active = input.getActiveInvocation();
      if (active === undefined) {
        const failure = reviewToolFailure('working_memory_review_failed', 'runtime_failure', 'never');
        input.recordOutcome?.(failure.outcome);
        return failure.result;
      }
      if (active.signal.aborted) {
        throw active.signal.reason ?? new DOMException('Working Memory review aborted.', 'AbortError');
      }
      try {
        const result = await input.memory.reviewWorkingMemory({
          threadId: active.message.conversationId,
          resourceId: active.message.householdId,
          principalRef: active.message.speaker.principalRef,
          requestedBy: active.requestedBy ?? 'user',
          now: input.now(),
        });
        input.recordOutcome?.(result.outcome);
        if (result.status === 'failed') {
          return reviewToolFailure(result.outcome.code, result.outcome.category ?? 'runtime_failure', result.outcome.retry ?? 'never').result;
        }
        return WorkingMemoryReviewToolResultSchema.parse(result.report);
      } catch {
        const failure = reviewToolFailure('working_memory_review_failed', 'runtime_failure', 'never');
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
  noteSuccessfulMutation?(input: { resourceId: string }): { reviewDue: boolean };
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
    inputSchema: WorkingMemoryMutationToolInputSchema,
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

      const canonicalDraft = {
        ...parsedDraft.data,
        basedOnRevision: inspection.revision,
      };

      const resolved = resolveWorkingMemoryMutation({
        draft: canonicalDraft,
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
          basedOnRevision: inspection.revision,
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
          basedOnRevision: inspection.revision,
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
        basedOnRevision: inspection.revision,
        mutation: resolved.mutation,
      });
      input.recordOutcome?.(applied.outcome);
      if (applied.status === 'failed') return mutationFailureResult(operation, applied.code, applied.category, applied.retry);
      const review = input.noteSuccessfulMutation?.({ resourceId: active.message.householdId });
      return WorkingMemoryMutationToolResultSchema.parse({
        status: 'applied',
        operation,
        code: 'working_memory_mutation_succeeded',
        ...(review?.reviewDue === true ? { reviewDue: true } : {}),
      });
    },
  });
}

export function createProposeWorkingMemoryTool(input: {
  memory: OrchestratorSessionMemoryPort;
  ids?: WorkingMemoryIdGenerator;
  now(): Date;
  getActiveInvocation(): ActiveWorkingMemoryInvocation | undefined;
  recordPendingMutation(proposal: PendingWorkingMemoryMutation): void;
  recordOutcome?(outcome: WorkingMemoryOperationOutcome): void;
}) {
  const ids = input.ids ?? createWorkingMemoryIdGenerator();
  return createTool({
    id: 'proposeWorkingMemory',
    description: [
      'Propose a bounded durable Working Memory fact from an explicit preference or identity signal.',
      'Call inspectWorkingMemory first in this same turn. A proposal is not saved until the existing confirmation flow approves it.',
      'Never provide entry IDs, owners, principal references, scope identifiers, lifecycle fields, or revisions.',
    ].join(' '),
    inputSchema: WorkingMemoryCandidateInputSchema,
    outputSchema: WorkingMemoryCandidateToolResultSchema,
    execute: async (rawDraft) => {
      const parsed = WorkingMemoryCandidateInputSchema.safeParse(rawDraft);
      const operation = 'create' as const;
      if (!parsed.success) return candidateFailureResult(operation, 'working_memory_candidate_invalid');

      const active = input.getActiveInvocation();
      if (active === undefined) return candidateFailureResult(operation, 'working_memory_candidate_failed', 'runtime_failure');
      if (active.signal.aborted) {
        throw active.signal.reason ?? new DOMException('Working Memory candidate aborted.', 'AbortError');
      }
      const inspection = active.workingMemoryInspection;
      if (inspection === undefined) return candidateFailureResult(operation, 'working_memory_inspection_required');

      const candidate = createWorkingMemoryCandidate({
        draft: parsed.data,
        principalRef: active.message.speaker.principalRef,
        inspectedRevision: inspection.revision,
        visibleEntries: inspection.entries,
      });
      if (candidate.status === 'failed') return candidateFailureResult(operation, candidate.code);

      const mutationDraft = candidate.operation === 'replace'
        ? {
            operation: 'replace' as const,
            basedOnRevision: inspection.revision,
            entryId: candidate.targetEntryId,
            kind: candidate.candidate.kind,
            summary: candidate.candidate.summary,
            value: candidate.candidate.value,
          }
        : {
            operation: 'create' as const,
            basedOnRevision: inspection.revision,
            kind: candidate.candidate.kind,
            summary: candidate.candidate.summary,
            scope: candidate.candidate.scope,
            value: candidate.candidate.value,
          };
      const resolved = resolveWorkingMemoryMutation({
        draft: mutationDraft,
        document: inspection.document,
        principalRef: active.message.speaker.principalRef,
        ids,
      });
      if (resolved.status === 'failed') return candidateFailureResult(candidate.operation, resolved.code);

      const validated = await input.memory.validateWorkingMemoryMutation({
        threadId: active.message.conversationId,
        resourceId: active.message.householdId,
        principalRef: active.message.speaker.principalRef,
        basedOnRevision: inspection.revision,
        mutation: resolved.mutation,
      });
      input.recordOutcome?.(validated.outcome);
      if (validated.status === 'failed') {
        return candidateFailureResult(candidate.operation, validated.code, validated.category, validated.retry);
      }

      const createdAt = input.now();
      const proposal = PendingWorkingMemoryMutationSchema.parse({
        proposalId: ids.nextProposalId(),
        householdId: active.message.householdId,
        conversationId: active.message.conversationId,
        speakerPrincipalRef: active.message.speaker.principalRef,
        mutation: resolved.mutation,
        basedOnRevision: inspection.revision,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + 15 * 60_000).toISOString(),
      });
      input.recordPendingMutation(proposal);
      input.recordOutcome?.({
        operation: 'candidate',
        status: 'succeeded',
        code: 'working_memory_candidate_proposed',
      });
      return WorkingMemoryCandidateToolResultSchema.parse({
        status: 'confirmation_required',
        operation: candidate.operation,
        code: 'working_memory_candidate_proposed',
        candidate: candidate.candidate,
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

function viewFailure(
  code: string,
  category: ErrorCategoryV1,
  retry: RetryDirectiveV1,
) {
  const outcome: WorkingMemoryOperationOutcome = {
    operation: 'read',
    status: 'failed',
    code,
    category,
    retry,
  };
  return {
    outcome,
    result: WorkingMemoryViewResultSchema.parse({ status: 'failed', code, category, retry }),
  };
}

function reviewToolFailure(
  code: string,
  category: ErrorCategoryV1,
  retry: RetryDirectiveV1,
) {
  const outcome: WorkingMemoryOperationOutcome = {
    operation: 'review',
    status: 'failed',
    code,
    category,
    retry,
  };
  return {
    outcome,
    result: WorkingMemoryReviewToolResultSchema.parse({ status: 'failed', code, category, retry }),
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

function candidateFailureResult(
  operation: 'create' | 'replace',
  code: string,
  category: ErrorCategoryV1 = 'validation_rejected',
  retry: RetryDirectiveV1 = 'never',
) {
  return WorkingMemoryCandidateToolResultSchema.parse({
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
