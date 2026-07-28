import type {
  ErrorCategoryV1,
  FlexibleWorkingMemory,
  JsonValue,
  ResolvedWorkingMemoryMutation,
  RetryDirectiveV1,
  WorkingMemoryInspectionResult,
  WorkingMemoryRevision,
  UtcInstant,
} from '@plus-one/contracts';
import {
  FlexibleWorkingMemorySchema,
  PlusOneError,
} from '@plus-one/contracts';
import { Memory } from '@mastra/memory';
import { createMastraMemoryStorage } from '@plus-one/database';
import {
  canonicalizeJson,
  getLogger,
  type ComponentEventName,
} from '@plus-one/runtime';
import { toMastraModel, type EngineLlmModelConfig } from '../mastra/role-agent.js';
import {
  applyResolvedWorkingMemoryMutation,
  createWorkingMemoryIdGenerator,
  decodeStoredWorkingMemory,
  verifyWorkingMemoryReadback,
  visibleWorkingMemoryEntries,
  workingMemoryRevision,
} from './working-memory-document.js';
import {
  projectWorkingMemoryForPrompt,
  workingMemoryPromptBlock,
  type WorkingMemoryPromptProjection,
} from './working-memory-prompt.js';
import { reviewWorkingMemoryDocument } from './working-memory-review.js';

const ORCHESTRATOR_LAST_MESSAGES = 20;
export const WORKING_MEMORY_REVIEW_AFTER_MUTATIONS = 3;
type OrchestratorMemoryOptions = NonNullable<NonNullable<ConstructorParameters<typeof Memory>[0]>['options']>;

export type WorkingMemoryOperation = 'read' | 'update' | 'clear' | 'inspect' | 'validate' | 'mutate' | 'candidate' | 'review' | 'observation';
export type WorkingMemoryMutationOperation = 'create' | 'replace' | 'delete' | 'clear';
type WorkingMemoryLogEvent = ComponentEventName<'runtime.memory'>;

export interface WorkingMemoryOperationOutcome {
  operation: WorkingMemoryOperation;
  status: 'succeeded' | 'failed';
  code: string;
  category?: ErrorCategoryV1;
  retry?: RetryDirectiveV1;
}

export type WorkingMemoryInspectionOutcome =
  | {
      status: 'succeeded';
      document: FlexibleWorkingMemory;
      inspection: WorkingMemoryInspectionResult;
      outcome: WorkingMemoryOperationOutcome;
    }
  | {
      status: 'failed';
      outcome: WorkingMemoryOperationOutcome;
      error: PlusOneError;
    };

export type WorkingMemoryPromptContextOutcome =
  | {
      status: 'succeeded';
      context: {
        projection: WorkingMemoryPromptProjection;
        prompt: string;
      };
      outcome: WorkingMemoryOperationOutcome;
    }
  | {
      status: 'failed';
      outcome: WorkingMemoryOperationOutcome;
      error: PlusOneError;
    };

export type WorkingMemoryReviewOutcome =
  | {
      status: 'succeeded';
      report: import('@plus-one/contracts').WorkingMemoryReviewReport;
      outcome: WorkingMemoryOperationOutcome;
    }
  | {
      status: 'failed';
      outcome: WorkingMemoryOperationOutcome;
      error: PlusOneError;
    };

export type WorkingMemoryMutationOutcome =
  | {
      status: 'succeeded';
      operation: WorkingMemoryMutationOperation;
      code: 'working_memory_mutation_succeeded' | 'working_memory_mutation_validated';
      document: FlexibleWorkingMemory;
      outcome: WorkingMemoryOperationOutcome;
    }
  | {
      status: 'failed';
      operation: WorkingMemoryMutationOperation;
      code: string;
      category: ErrorCategoryV1;
      retry: RetryDirectiveV1;
      outcome: WorkingMemoryOperationOutcome;
      error?: PlusOneError;
    };

export type WorkingMemoryMutationValidationOutcome = WorkingMemoryMutationOutcome;

export interface OrchestratorSessionMemoryPort {
  readonly agentMemory: Memory;
  readonly degradedAgentMemory?: Memory | undefined;
  inspectWorkingMemory(input: {
    threadId: string;
    resourceId: string;
    principalRef: string;
  }): Promise<WorkingMemoryInspectionOutcome>;
  readWorkingMemoryPromptContext(input: {
    threadId: string;
    resourceId: string;
    principalRef: string;
  }): Promise<WorkingMemoryPromptContextOutcome>;
  reviewWorkingMemory(input: {
    threadId: string;
    resourceId: string;
    principalRef: string;
    requestedBy: 'user' | 'scheduled_review';
    now: Date;
  }): Promise<WorkingMemoryReviewOutcome>;
  noteWorkingMemoryMutationSuccess(input: { resourceId: string }): { reviewDue: boolean };
  acknowledgeWorkingMemoryReview(input: { resourceId: string }): void;
  validateWorkingMemoryMutation(input: {
    threadId: string;
    resourceId: string;
    principalRef: string;
    basedOnRevision: WorkingMemoryRevision;
    mutation: ResolvedWorkingMemoryMutation;
  }): Promise<WorkingMemoryMutationValidationOutcome>;
  applyWorkingMemoryMutation(input: {
    threadId: string;
    resourceId: string;
    principalRef: string;
    basedOnRevision: WorkingMemoryRevision;
    mutation: ResolvedWorkingMemoryMutation;
  }): Promise<WorkingMemoryMutationOutcome>;
  close(): Promise<void>;
}

type OrchestratorSessionMemoryInput =
  | { connectionString: string; model: EngineLlmModelConfig; memory?: never; close?: never }
  | { memory: Memory; connectionString?: never; model?: never; close?: () => Promise<void> };

type LoadedFlexibleWorkingMemory =
  | { document: FlexibleWorkingMemory; migrated: boolean }
  | { error: PlusOneError };

export function createOrchestratorSessionMemory(
  input: OrchestratorSessionMemoryInput,
): OrchestratorSessionMemoryPort {
  if ('memory' in input) {
    return new OrchestratorSessionMemory(input.memory, undefined, input.close);
  }

  const storage = createMastraMemoryStorage(input.connectionString);
  const memory = new Memory({
    storage,
    options: orchestratorSessionMemoryOptions(input.model),
  });
  const degradedMemory = new Memory({
    storage,
    options: {
      lastMessages: false,
      semanticRecall: false,
      workingMemory: { enabled: false },
      observationalMemory: false,
    },
  });
  return new OrchestratorSessionMemory(memory, degradedMemory, async () => {
    await storage.close?.();
  });
}

class OrchestratorSessionMemory implements OrchestratorSessionMemoryPort {
  private readonly mutex = new ResourceMutex();
  private readonly successfulMutations = new Map<string, number>();
  private closed = false;

  constructor(
    readonly agentMemory: Memory,
    readonly degradedAgentMemory?: Memory,
    private readonly closeStorage?: () => Promise<void>,
    private readonly ids = createWorkingMemoryIdGenerator(),
  ) {}

  async inspectWorkingMemory(input: {
    threadId: string;
    resourceId: string;
    principalRef: string;
  }): Promise<WorkingMemoryInspectionOutcome> {
    const startedAt = Date.now();
    return this.mutex.run(input.resourceId, async () => {
      const loaded = await this.loadFlexibleWorkingMemory(input);
      if ('error' in loaded) {
        const result = inspectionFailure('inspect', loaded.error);
        this.logOutcome('working_memory.read.failed', startedAt, result.outcome);
        return result;
      }
      const current = loaded.migrated
        ? await this.persistAndVerifyMigration(input, loaded.document, 'inspect')
        : loaded.document;
      if (current instanceof PlusOneError) {
        const result = inspectionFailure('inspect', current);
        this.logOutcome('working_memory.read.failed', startedAt, result.outcome);
        return result;
      }
      const result: WorkingMemoryInspectionOutcome = {
        status: 'succeeded',
        document: current,
        inspection: {
          revision: workingMemoryRevision(current),
          entries: visibleWorkingMemoryEntries({ document: current, principalRef: input.principalRef }),
        },
        outcome: {
          operation: 'inspect',
          status: 'succeeded',
          code: 'working_memory_inspection_succeeded',
        },
      };
      this.logOutcome('working_memory.read.completed', startedAt, result.outcome, {
        recordCount: result.inspection.entries.length,
      });
      return result;
    });
  }

  async readWorkingMemoryPromptContext(input: {
    threadId: string;
    resourceId: string;
    principalRef: string;
  }): Promise<WorkingMemoryPromptContextOutcome> {
    const startedAt = Date.now();
    return this.mutex.run(input.resourceId, async () => {
      const loaded = await this.loadFlexibleWorkingMemory(input);
      if ('error' in loaded) {
        const result = promptContextFailure(loaded.error);
        this.logOutcome('working_memory.read.failed', startedAt, result.outcome);
        return result;
      }
      const current = loaded.migrated
        ? await this.persistAndVerifyMigration(input, loaded.document, 'read')
        : loaded.document;
      if (current instanceof PlusOneError) {
        const result = promptContextFailure(current);
        this.logOutcome('working_memory.read.failed', startedAt, result.outcome);
        return result;
      }
      const projection = projectWorkingMemoryForPrompt({
        document: current,
        principalRef: input.principalRef,
      });
      const result: WorkingMemoryPromptContextOutcome = {
        status: 'succeeded',
        context: {
          projection,
          prompt: workingMemoryPromptBlock(projection),
        },
        outcome: {
          operation: 'read',
          status: 'succeeded',
          code: 'working_memory_prompt_context_succeeded',
        },
      };
      this.logOutcome('working_memory.read.completed', startedAt, result.outcome);
      return result;
    });
  }

  async reviewWorkingMemory(input: {
    threadId: string;
    resourceId: string;
    principalRef: string;
    requestedBy: 'user' | 'scheduled_review';
    now: Date;
  }): Promise<WorkingMemoryReviewOutcome> {
    const startedAt = Date.now();
    return this.mutex.run(input.resourceId, async () => {
      const loaded = await this.loadFlexibleWorkingMemory(input);
      if ('error' in loaded) {
        const result = reviewFailure(loaded.error);
        this.logOutcome('working_memory.review.failed', startedAt, result.outcome, {
          requestedBy: input.requestedBy,
        });
        return result;
      }
      const current = loaded.migrated
        ? await this.persistAndVerifyMigration(input, loaded.document, 'review')
        : loaded.document;
      if (current instanceof PlusOneError) {
        const result = reviewFailure(current);
        this.logOutcome('working_memory.review.failed', startedAt, result.outcome, {
          requestedBy: input.requestedBy,
        });
        return result;
      }
      const report = reviewWorkingMemoryDocument({
        document: current,
        principalRef: input.principalRef,
        now: input.now.toISOString() as UtcInstant,
      });
      this.acknowledgeWorkingMemoryReview({ resourceId: input.resourceId });
      const result: WorkingMemoryReviewOutcome = {
        status: 'succeeded',
        report,
        outcome: {
          operation: 'review',
          status: 'succeeded',
          code: 'working_memory_review_succeeded',
        },
      };
      this.logOutcome('working_memory.review.completed', startedAt, result.outcome, {
        requestedBy: input.requestedBy,
        findingCount: report.findings.length,
      });
      return result;
    });
  }

  noteWorkingMemoryMutationSuccess(input: { resourceId: string }): { reviewDue: boolean } {
    const count = (this.successfulMutations.get(input.resourceId) ?? 0) + 1;
    this.successfulMutations.set(input.resourceId, count);
    return { reviewDue: count >= WORKING_MEMORY_REVIEW_AFTER_MUTATIONS };
  }

  acknowledgeWorkingMemoryReview(input: { resourceId: string }): void {
    this.successfulMutations.delete(input.resourceId);
  }

  async validateWorkingMemoryMutation(input: {
    threadId: string;
    resourceId: string;
    principalRef: string;
    basedOnRevision: WorkingMemoryRevision;
    mutation: ResolvedWorkingMemoryMutation;
  }): Promise<WorkingMemoryMutationValidationOutcome> {
    const startedAt = Date.now();
    return this.mutex.run(input.resourceId, async () => {
      const loaded = await this.loadCurrentFlexibleWorkingMemory(input, 'validate');
      if ('error' in loaded) {
        const result = mutationFailure(input.mutation.operation, loaded.error.code, loaded.error.category, loaded.error.retry, loaded.error);
        this.logOutcome(mutationFailureEvent(result.code), startedAt, {
          ...result.outcome,
          operation: 'validate',
        });
        return result;
      }
      if (workingMemoryRevision(loaded.document) !== input.basedOnRevision) {
        const result = mutationFailure(input.mutation.operation, 'working_memory_revision_stale', 'serialization_conflict', 'after_state_resolution');
        this.logOutcome('working_memory.mutation.rejected', startedAt, {
          ...result.outcome,
          operation: 'validate',
        });
        return result;
      }
      const applied = applyResolvedWorkingMemoryMutation({
        document: loaded.document,
        mutation: input.mutation,
        principalRef: input.principalRef,
        now: new Date(),
      });
      if (applied.status === 'failed') {
        const result = mutationFailure(input.mutation.operation, applied.code, mutationFailureCategory(applied.code), 'never');
        this.logOutcome('working_memory.mutation.rejected', startedAt, {
          ...result.outcome,
          operation: 'validate',
        });
        return result;
      }
      const result = mutationSuccess(input.mutation.operation, 'working_memory_mutation_validated', applied.document, 'validate');
      this.logOutcome('working_memory.mutation.completed', startedAt, result.outcome, {
        recordCount: Object.keys(applied.document.entries).length,
      });
      return result;
    });
  }

  async applyWorkingMemoryMutation(input: {
    threadId: string;
    resourceId: string;
    principalRef: string;
    basedOnRevision: WorkingMemoryRevision;
    mutation: ResolvedWorkingMemoryMutation;
  }): Promise<WorkingMemoryMutationOutcome> {
    const startedAt = Date.now();
    return this.mutex.run(input.resourceId, async () => {
      const loaded = await this.loadCurrentFlexibleWorkingMemory(input, 'mutate');
      if ('error' in loaded) {
        const result = mutationFailure(input.mutation.operation, loaded.error.code, loaded.error.category, loaded.error.retry, loaded.error);
        this.logOutcome(mutationFailureEvent(result.code), startedAt, result.outcome);
        return result;
      }
      if (workingMemoryRevision(loaded.document) !== input.basedOnRevision) {
        const result = mutationFailure(input.mutation.operation, 'working_memory_revision_stale', 'serialization_conflict', 'after_state_resolution');
        this.logOutcome('working_memory.mutation.rejected', startedAt, result.outcome);
        return result;
      }
      const applied = applyResolvedWorkingMemoryMutation({
        document: loaded.document,
        mutation: input.mutation,
        principalRef: input.principalRef,
        now: new Date(),
      });
      if (applied.status === 'failed') {
        const result = mutationFailure(input.mutation.operation, applied.code, mutationFailureCategory(applied.code), 'never');
        this.logOutcome('working_memory.mutation.rejected', startedAt, result.outcome);
        return result;
      }

      try {
        await this.agentMemory.updateWorkingMemory({
          threadId: input.threadId,
          resourceId: input.resourceId,
          workingMemory: canonicalWorkingMemoryJson(applied.document),
        });
      } catch (error) {
        const result = mutationFailure(input.mutation.operation, 'working_memory_write_failed', 'storage_unavailable', 'after_backoff', error);
        this.logOutcome('working_memory.write.failed', startedAt, result.outcome);
        return result;
      }

      const readback = await this.loadFlexibleWorkingMemory(input);
      if ('error' in readback || readback.migrated || !verifyWorkingMemoryReadback({
        before: loaded.document,
        after: readback.document,
        mutation: input.mutation,
      })) {
        const result = mutationFailure(input.mutation.operation, 'working_memory_readback_mismatch', 'readback_mismatch', 'after_backoff');
        this.logOutcome('working_memory.readback.failed', startedAt, result.outcome);
        return result;
      }
      const result = mutationSuccess(input.mutation.operation, 'working_memory_mutation_succeeded', readback.document, 'mutate');
      this.logOutcome('working_memory.mutation.completed', startedAt, result.outcome, {
        recordCount: Object.keys(readback.document.entries).length,
      });
      return result;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.closeStorage?.();
  }

  private async loadFlexibleWorkingMemory(input: {
    threadId: string;
    resourceId: string;
  }): Promise<LoadedFlexibleWorkingMemory> {
    let stored: string | null;
    try {
      stored = await this.agentMemory.getWorkingMemory(input);
    } catch (error) {
      return { error: newMemoryError('working_memory_read_failed', 'storage_unavailable', 'after_backoff', error) };
    }
    const decoded = decodeStoredWorkingMemory({ stored, ids: this.ids, now: new Date() });
    if (decoded.status === 'failed') {
      return { error: newMemoryError(decoded.code, 'validation_rejected', 'never', undefined) };
    }
    return { document: decoded.document, migrated: decoded.migrated };
  }

  private async loadCurrentFlexibleWorkingMemory(input: {
    threadId: string;
    resourceId: string;
  }, operation: 'validate' | 'mutate'): Promise<{ document: FlexibleWorkingMemory } | { error: PlusOneError }> {
    const loaded = await this.loadFlexibleWorkingMemory(input);
    if ('error' in loaded) return loaded;
    if (!loaded.migrated) return { document: loaded.document };
    const persisted = await this.persistAndVerifyMigration(input, loaded.document, operation);
    return persisted instanceof PlusOneError ? { error: persisted } : { document: persisted };
  }

  private async persistAndVerifyMigration(
    input: { threadId: string; resourceId: string },
    document: FlexibleWorkingMemory,
    operation: WorkingMemoryOperation,
  ): Promise<FlexibleWorkingMemory | PlusOneError> {
    const startedAt = Date.now();
    try {
      await this.agentMemory.updateWorkingMemory({
        threadId: input.threadId,
        resourceId: input.resourceId,
        workingMemory: canonicalWorkingMemoryJson(document),
      });
    } catch (error) {
      const result = newMemoryError('working_memory_write_failed', 'storage_unavailable', 'after_backoff', error);
      this.logOutcome('working_memory.migration.failed', startedAt, errorOutcome(operation, result));
      return result;
    }
    const readback = await this.loadFlexibleWorkingMemory(input);
    if ('error' in readback || readback.migrated || workingMemoryRevision(readback.document) !== workingMemoryRevision(document)) {
      const result = newMemoryError('working_memory_readback_mismatch', 'readback_mismatch', 'after_backoff', undefined);
      this.logOutcome('working_memory.migration.failed', startedAt, errorOutcome(operation, result));
      return result;
    }
    this.logOutcome('working_memory.migration.completed', startedAt, {
      operation,
      status: 'succeeded',
      code: 'working_memory_migration_succeeded',
    }, {
      recordCount: Object.keys(readback.document.entries).length,
    });
    return readback.document;
  }

  private logOutcome(
    eventName: WorkingMemoryLogEvent,
    startedAt: number,
    outcome: WorkingMemoryOperationOutcome,
    extra: Readonly<Record<string, string | number | boolean>> = {},
  ): void {
    const logger = getLogger('runtime.memory');
    const fields = {
      operation: outcome.operation,
      outcomeCode: outcome.code,
      ...(outcome.category === undefined ? {} : { failureCategory: outcome.category }),
      ...(outcome.retry === undefined ? {} : { retryDirective: outcome.retry }),
      durationMs: Math.max(0, Date.now() - startedAt),
      ...extra,
    };
    if (eventName === 'working_memory.read.completed') {
      logger.debug(eventName, { fields });
    } else if (eventName === 'working_memory.mutation.rejected') {
      logger.warn(eventName, { fields });
    } else if (
      eventName === 'working_memory.mutation.completed'
      || eventName === 'working_memory.migration.completed'
      || eventName === 'working_memory.review.completed'
    ) {
      logger.info(eventName, { fields });
    } else {
      logger.error(eventName, { fields });
    }
  }
}

class ResourceMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(resourceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(resourceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(resourceId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(resourceId) === current) this.tails.delete(resourceId);
    }
  }
}

export function orchestratorSessionMemoryOptions(model: EngineLlmModelConfig): OrchestratorMemoryOptions {
  return {
    lastMessages: ORCHESTRATOR_LAST_MESSAGES,
    semanticRecall: false,
    workingMemory: {
      enabled: true,
      scope: 'resource',
      schema: FlexibleWorkingMemorySchema,
      agentManaged: false,
    },
    observationalMemory: {
      model: toMastraModel(model),
      scope: 'thread',
      retrieval: { scope: 'thread' },
      observation: { manageWorkingMemory: false },
    },
  };
}

function newMemoryError(
  code: string,
  category: ErrorCategoryV1,
  retry: RetryDirectiveV1,
  cause: unknown,
): PlusOneError {
  return new PlusOneError({
    category,
    code,
    message: 'Working Memory operation failed.',
    retry,
    receiptLookupRequired: false,
    details: { operation: 'working_memory' },
    cause,
  });
}

function inspectionFailure(operation: 'inspect', error: PlusOneError): WorkingMemoryInspectionOutcome {
  return {
    status: 'failed',
    outcome: {
      operation,
      status: 'failed',
      code: error.code,
      category: error.category,
      retry: error.retry,
    },
    error,
  };
}

function promptContextFailure(error: PlusOneError): WorkingMemoryPromptContextOutcome {
  return {
    status: 'failed',
    outcome: {
      operation: 'read',
      status: 'failed',
      code: error.code,
      category: error.category,
      retry: error.retry,
    },
    error,
  };
}

function reviewFailure(error: PlusOneError): WorkingMemoryReviewOutcome {
  return {
    status: 'failed',
    outcome: {
      operation: 'review',
      status: 'failed',
      code: error.code,
      category: error.category,
      retry: error.retry,
    },
    error,
  };
}

function mutationSuccess(
  operation: WorkingMemoryMutationOperation,
  code: 'working_memory_mutation_succeeded' | 'working_memory_mutation_validated',
  document: FlexibleWorkingMemory,
  outcomeOperation: 'validate' | 'mutate',
): WorkingMemoryMutationOutcome {
  return {
    status: 'succeeded',
    operation,
    code,
    document,
    outcome: {
      operation: outcomeOperation,
      status: 'succeeded',
      code,
    },
  };
}

function mutationFailure(
  operation: WorkingMemoryMutationOperation,
  code: string,
  category: ErrorCategoryV1,
  retry: RetryDirectiveV1,
  cause?: unknown,
): WorkingMemoryMutationOutcome {
  const error = cause instanceof PlusOneError
    ? cause
    : newMemoryError(code, category, retry, cause);
  return {
    status: 'failed',
    operation,
    code,
    category,
    retry,
    outcome: {
      operation: 'mutate',
      status: 'failed',
      code,
      category,
      retry,
    },
    error,
  };
}

function mutationFailureCategory(code: string): ErrorCategoryV1 {
  if (code === 'working_memory_entry_forbidden') return 'policy_rejected';
  if (code === 'working_memory_entry_not_found') return 'validation_rejected';
  return 'validation_rejected';
}

function mutationFailureEvent(code: string): WorkingMemoryLogEvent {
  if (code === 'working_memory_write_failed') return 'working_memory.write.failed';
  if (code === 'working_memory_readback_mismatch') return 'working_memory.readback.failed';
  if (code === 'working_memory_read_failed') return 'working_memory.read.failed';
  return 'working_memory.mutation.rejected';
}

function errorOutcome(
  operation: WorkingMemoryOperation,
  error: PlusOneError,
): WorkingMemoryOperationOutcome {
  return {
    operation,
    status: 'failed',
    code: error.code,
    category: error.category,
    retry: error.retry,
  };
}

function canonicalWorkingMemoryJson(document: FlexibleWorkingMemory): string {
  return canonicalizeJson(JSON.parse(JSON.stringify(document)) as JsonValue);
}
