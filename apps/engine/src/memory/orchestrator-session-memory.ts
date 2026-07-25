import type {
  ErrorCategoryV1,
  FlexibleWorkingMemory,
  JsonValue,
  HouseholdWorkingMemory,
  HouseholdWorkingMemoryPatch,
  ResolvedWorkingMemoryMutation,
  RetryDirectiveV1,
  WorkingMemoryInspectionResult,
  WorkingMemoryRevision,
} from '@plus-one/contracts';
import {
  FlexibleWorkingMemorySchema,
  HouseholdWorkingMemoryPatchSchema,
  HouseholdWorkingMemorySchema,
  PlusOneError,
} from '@plus-one/contracts';
import { Memory, deepMergeWorkingMemory } from '@mastra/memory';
import { createMastraMemoryStorage } from '@plus-one/database';
import { canonicalizeJson } from '@plus-one/runtime';
import { toMastraModel, type EngineLlmModelConfig } from '../mastra/role-agent.js';
import {
  applyResolvedWorkingMemoryMutation,
  createWorkingMemoryIdGenerator,
  decodeStoredWorkingMemory,
  verifyWorkingMemoryReadback,
  visibleWorkingMemoryEntries,
  workingMemoryRevision,
} from './working-memory-document.js';

const ORCHESTRATOR_LAST_MESSAGES = 20;
type OrchestratorMemoryOptions = NonNullable<NonNullable<ConstructorParameters<typeof Memory>[0]>['options']>;

export type WorkingMemoryOperation = 'read' | 'update' | 'clear' | 'inspect' | 'validate' | 'mutate' | 'observation';
export type WorkingMemoryMutationOperation = 'create' | 'replace' | 'delete' | 'clear';

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

export type WorkingMemoryReadResult =
  | {
      status: 'succeeded';
      value: HouseholdWorkingMemory;
      outcome: WorkingMemoryOperationOutcome;
    }
  | {
      status: 'failed';
      outcome: WorkingMemoryOperationOutcome;
      error: PlusOneError;
    };

export interface OrchestratorSessionMemoryPort {
  readonly agentMemory: Memory;
  readonly degradedAgentMemory?: Memory | undefined;
  readWorkingMemory(input: { threadId: string; resourceId: string }): Promise<WorkingMemoryReadResult>;
  applyWorkingMemoryPatch(input: {
    threadId: string;
    resourceId: string;
    patch: HouseholdWorkingMemoryPatch;
  }): Promise<WorkingMemoryOperationOutcome>;
  clearWorkingMemory(input: { threadId: string; resourceId: string }): Promise<WorkingMemoryOperationOutcome>;
  inspectWorkingMemory(input: {
    threadId: string;
    resourceId: string;
    principalRef: string;
  }): Promise<WorkingMemoryInspectionOutcome>;
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

type LoadedWorkingMemory =
  | { value: HouseholdWorkingMemory }
  | { error: PlusOneError };

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
  private closed = false;

  constructor(
    readonly agentMemory: Memory,
    readonly degradedAgentMemory?: Memory,
    private readonly closeStorage?: () => Promise<void>,
    private readonly ids = createWorkingMemoryIdGenerator(),
  ) {}

  async readWorkingMemory(input: { threadId: string; resourceId: string }): Promise<WorkingMemoryReadResult> {
    const loaded = await this.loadWorkingMemory(input);
    if ('error' in loaded) {
      return {
        status: 'failed',
        outcome: outcomeFromError('read', loaded.error),
        error: loaded.error,
      };
    }
    return {
      status: 'succeeded',
      value: loaded.value,
      outcome: {
        operation: 'read',
        status: 'succeeded',
        code: 'working_memory_read_succeeded',
      },
    };
  }

  async applyWorkingMemoryPatch(input: {
    threadId: string;
    resourceId: string;
    patch: HouseholdWorkingMemoryPatch;
  }): Promise<WorkingMemoryOperationOutcome> {
    return this.mutex.run(input.resourceId, async () => this.applyPatch(input, 'update'));
  }

  async clearWorkingMemory(input: {
    threadId: string;
    resourceId: string;
  }): Promise<WorkingMemoryOperationOutcome> {
    const clearPatch: HouseholdWorkingMemoryPatch = {
      goals: null,
      savingPreferences: null,
      communication: null,
      conventions: null,
      members: null,
    };
    return this.mutex.run(input.resourceId, async () => this.applyPatch({ ...input, patch: clearPatch }, 'clear'));
  }

  async inspectWorkingMemory(input: {
    threadId: string;
    resourceId: string;
    principalRef: string;
  }): Promise<WorkingMemoryInspectionOutcome> {
    return this.mutex.run(input.resourceId, async () => {
      const loaded = await this.loadFlexibleWorkingMemory(input);
      if ('error' in loaded) return inspectionFailure('inspect', loaded.error);
      const current = loaded.migrated
        ? await this.persistAndVerifyMigration(input, loaded.document)
        : loaded.document;
      if (current instanceof PlusOneError) return inspectionFailure('inspect', current);
      return {
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
    });
  }

  async validateWorkingMemoryMutation(input: {
    threadId: string;
    resourceId: string;
    principalRef: string;
    basedOnRevision: WorkingMemoryRevision;
    mutation: ResolvedWorkingMemoryMutation;
  }): Promise<WorkingMemoryMutationValidationOutcome> {
    return this.mutex.run(input.resourceId, async () => {
      const loaded = await this.loadCurrentFlexibleWorkingMemory(input);
      if ('error' in loaded) return mutationFailure(input.mutation.operation, loaded.error.code, loaded.error.category, loaded.error.retry, loaded.error);
      if (workingMemoryRevision(loaded.document) !== input.basedOnRevision) {
        return mutationFailure(input.mutation.operation, 'working_memory_revision_stale', 'serialization_conflict', 'after_state_resolution');
      }
      const applied = applyResolvedWorkingMemoryMutation({
        document: loaded.document,
        mutation: input.mutation,
        principalRef: input.principalRef,
      });
      if (applied.status === 'failed') {
        return mutationFailure(input.mutation.operation, applied.code, mutationFailureCategory(applied.code), 'never');
      }
      return mutationSuccess(input.mutation.operation, 'working_memory_mutation_validated', applied.document, 'validate');
    });
  }

  async applyWorkingMemoryMutation(input: {
    threadId: string;
    resourceId: string;
    principalRef: string;
    basedOnRevision: WorkingMemoryRevision;
    mutation: ResolvedWorkingMemoryMutation;
  }): Promise<WorkingMemoryMutationOutcome> {
    return this.mutex.run(input.resourceId, async () => {
      const loaded = await this.loadCurrentFlexibleWorkingMemory(input);
      if ('error' in loaded) return mutationFailure(input.mutation.operation, loaded.error.code, loaded.error.category, loaded.error.retry, loaded.error);
      if (workingMemoryRevision(loaded.document) !== input.basedOnRevision) {
        return mutationFailure(input.mutation.operation, 'working_memory_revision_stale', 'serialization_conflict', 'after_state_resolution');
      }
      const applied = applyResolvedWorkingMemoryMutation({
        document: loaded.document,
        mutation: input.mutation,
        principalRef: input.principalRef,
      });
      if (applied.status === 'failed') {
        return mutationFailure(input.mutation.operation, applied.code, mutationFailureCategory(applied.code), 'never');
      }

      try {
        await this.agentMemory.updateWorkingMemory({
          threadId: input.threadId,
          resourceId: input.resourceId,
          workingMemory: canonicalWorkingMemoryJson(applied.document),
        });
      } catch (error) {
        return mutationFailure(input.mutation.operation, 'working_memory_write_failed', 'storage_unavailable', 'after_backoff', error);
      }

      const readback = await this.loadFlexibleWorkingMemory(input);
      if ('error' in readback || readback.migrated || !verifyWorkingMemoryReadback({
        before: loaded.document,
        after: readback.document,
        mutation: input.mutation,
      })) {
        return mutationFailure(input.mutation.operation, 'working_memory_readback_mismatch', 'readback_mismatch', 'after_backoff');
      }
      return mutationSuccess(input.mutation.operation, 'working_memory_mutation_succeeded', readback.document, 'mutate');
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
    const decoded = decodeStoredWorkingMemory({ stored, ids: this.ids });
    if (decoded.status === 'failed') {
      return { error: newMemoryError(decoded.code, 'validation_rejected', 'never', undefined) };
    }
    return { document: decoded.document, migrated: decoded.migrated };
  }

  private async loadCurrentFlexibleWorkingMemory(input: {
    threadId: string;
    resourceId: string;
  }): Promise<{ document: FlexibleWorkingMemory } | { error: PlusOneError }> {
    const loaded = await this.loadFlexibleWorkingMemory(input);
    if ('error' in loaded) return loaded;
    if (!loaded.migrated) return { document: loaded.document };
    const persisted = await this.persistAndVerifyMigration(input, loaded.document);
    return persisted instanceof PlusOneError ? { error: persisted } : { document: persisted };
  }

  private async persistAndVerifyMigration(
    input: { threadId: string; resourceId: string },
    document: FlexibleWorkingMemory,
  ): Promise<FlexibleWorkingMemory | PlusOneError> {
    try {
      await this.agentMemory.updateWorkingMemory({
        threadId: input.threadId,
        resourceId: input.resourceId,
        workingMemory: canonicalWorkingMemoryJson(document),
      });
    } catch (error) {
      return newMemoryError('working_memory_write_failed', 'storage_unavailable', 'after_backoff', error);
    }
    const readback = await this.loadFlexibleWorkingMemory(input);
    if ('error' in readback || readback.migrated || workingMemoryRevision(readback.document) !== workingMemoryRevision(document)) {
      return newMemoryError('working_memory_readback_mismatch', 'readback_mismatch', 'after_backoff', undefined);
    }
    return readback.document;
  }

  private async applyPatch(
    input: {
      threadId: string;
      resourceId: string;
      patch: HouseholdWorkingMemoryPatch;
    },
    operation: 'update' | 'clear',
  ): Promise<WorkingMemoryOperationOutcome> {
    const loaded = await this.loadWorkingMemory(input);
    if ('error' in loaded) return outcomeFromError(operation, loaded.error);

    const patch = HouseholdWorkingMemoryPatchSchema.safeParse(input.patch);
    if (!patch.success) {
      return failedOutcome(
        operation,
        operation === 'clear' ? 'working_memory_clear_failed' : 'working_memory_update_rejected',
        'validation_rejected',
        'never',
        patch.error,
      );
    }

    const merged = deepMergeWorkingMemory(
      loaded.value as Record<string, unknown>,
      patch.data as Record<string, unknown>,
    );
    const complete = HouseholdWorkingMemorySchema.safeParse(merged);
    if (!complete.success) {
      return failedOutcome(
        operation,
        operation === 'clear' ? 'working_memory_clear_failed' : 'working_memory_update_rejected',
        'validation_rejected',
        'never',
        complete.error,
      );
    }

    try {
      await this.agentMemory.updateWorkingMemory({
        threadId: input.threadId,
        resourceId: input.resourceId,
        workingMemory: JSON.stringify(complete.data),
      });
      return {
        operation,
        status: 'succeeded',
        code: operation === 'clear' ? 'working_memory_clear_succeeded' : 'working_memory_update_succeeded',
      };
    } catch (error) {
      return failedOutcome(
        operation,
        operation === 'clear' ? 'working_memory_clear_failed' : 'working_memory_write_failed',
        'storage_unavailable',
        'after_backoff',
        error,
      );
    }
  }

  private async loadWorkingMemory(input: { threadId: string; resourceId: string }): Promise<LoadedWorkingMemory> {
    let stored: string | null;
    try {
      stored = await this.agentMemory.getWorkingMemory(input);
    } catch (error) {
      return {
        error: newMemoryError(
          'working_memory_read_failed',
          'storage_unavailable',
          'after_backoff',
          error,
        ),
      };
    }

    let parsed: unknown = {};
    if (stored !== null) {
      try {
        parsed = JSON.parse(stored);
      } catch (error) {
        return {
          error: newMemoryError(
            'working_memory_read_failed',
            'validation_rejected',
            'never',
            error,
          ),
        };
      }
    }

    const result = HouseholdWorkingMemorySchema.safeParse(parsed);
    if (!result.success) {
      return {
        error: newMemoryError(
          'working_memory_read_failed',
          'validation_rejected',
          'never',
          result.error,
        ),
      };
    }
    return { value: result.data };
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

function outcomeFromError(
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

function failedOutcome(
  operation: WorkingMemoryOperation,
  code: string,
  category: ErrorCategoryV1,
  retry: RetryDirectiveV1,
  cause: unknown,
): WorkingMemoryOperationOutcome {
  void cause;
  return {
    operation,
    status: 'failed',
    code,
    category,
    retry,
  } as WorkingMemoryOperationOutcome;
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
    outcome: outcomeFromError(operation, error),
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

function canonicalWorkingMemoryJson(document: FlexibleWorkingMemory): string {
  return canonicalizeJson(JSON.parse(JSON.stringify(document)) as JsonValue);
}
