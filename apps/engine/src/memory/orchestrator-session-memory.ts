import type { ErrorCategoryV1, HouseholdWorkingMemory, HouseholdWorkingMemoryPatch, RetryDirectiveV1 } from '@plus-one/contracts';
import {
  HouseholdWorkingMemoryPatchSchema,
  HouseholdWorkingMemoryAgentPatchSchema,
  HouseholdWorkingMemorySchema,
  PlusOneError,
} from '@plus-one/contracts';
import { Memory, deepMergeWorkingMemory } from '@mastra/memory';
import { createMastraMemoryStorage } from '@plus-one/database';
import { toMastraModel, type EngineLlmModelConfig } from '../mastra/role-agent.js';

const ORCHESTRATOR_LAST_MESSAGES = 20;
type OrchestratorMemoryOptions = NonNullable<NonNullable<ConstructorParameters<typeof Memory>[0]>['options']>;

export type WorkingMemoryOperation = 'read' | 'update' | 'clear' | 'observation';

export interface WorkingMemoryOperationOutcome {
  operation: WorkingMemoryOperation;
  status: 'succeeded' | 'failed';
  code: string;
  category?: ErrorCategoryV1;
  retry?: RetryDirectiveV1;
}

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
  close(): Promise<void>;
}

type OrchestratorSessionMemoryInput =
  | { connectionString: string; model: EngineLlmModelConfig; memory?: never; close?: never }
  | { memory: Memory; connectionString?: never; model?: never; close?: () => Promise<void> };

type LoadedWorkingMemory =
  | { value: HouseholdWorkingMemory }
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.closeStorage?.();
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
      schema: HouseholdWorkingMemoryAgentPatchSchema,
      agentManaged: true,
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
