import { describe, expect, it, vi } from 'vitest';
import { Memory } from '@mastra/memory';
import {
  HouseholdWorkingMemoryAgentPatchSchema,
  PlusOneError,
} from '@plus-one/contracts';
import {
  createOrchestratorSessionMemory,
  orchestratorSessionMemoryOptions,
  type OrchestratorSessionMemoryPort,
} from '../src/memory/orchestrator-session-memory.js';

const model = {
  id: 'openai/gpt-4.1-mini',
  endpoint: 'https://llm.example.test/v1',
  apiKey: 'test-api-key',
};
const threadId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const resourceId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';

function fakeMemory(initial: string | null = null) {
  let workingMemory = initial;
  const getWorkingMemory = vi.fn(async () => workingMemory);
  const updateWorkingMemory = vi.fn(async (input: { workingMemory: string }) => {
    workingMemory = input.workingMemory;
  });
  return {
    memory: { getWorkingMemory, updateWorkingMemory } as unknown as Memory,
    getWorkingMemory,
    updateWorkingMemory,
  };
}

function createMemoryPort(input: ReturnType<typeof fakeMemory>): OrchestratorSessionMemoryPort {
  return createOrchestratorSessionMemory({ memory: input.memory });
}

describe('orchestratorSessionMemoryOptions', () => {
  it('enables resource-scoped agent-managed Working Memory and thread-scoped OM', () => {
    expect(orchestratorSessionMemoryOptions(model)).toMatchObject({
      lastMessages: 20,
      semanticRecall: false,
      workingMemory: {
        enabled: true,
        scope: 'resource',
        agentManaged: true,
        schema: HouseholdWorkingMemoryAgentPatchSchema,
      },
      observationalMemory: {
        model: {
          id: model.id,
          url: model.endpoint,
          apiKey: model.apiKey,
        },
        scope: 'thread',
        retrieval: { scope: 'thread' },
        observation: { manageWorkingMemory: false },
      },
    });
  });
});

describe('OrchestratorSessionMemory', () => {
  it('reads and validates a stored Working Memory document', async () => {
    const stored = { members: { 'telegram:user:1': { nickname: 'Alex' } } };
    const input = fakeMemory(JSON.stringify(stored));
    const memory = createMemoryPort(input);

    await expect(memory.readWorkingMemory({ threadId, resourceId })).resolves.toMatchObject({
      status: 'succeeded',
      value: stored,
      outcome: {
        operation: 'read',
        status: 'succeeded',
        code: 'working_memory_read_succeeded',
      },
    });
    expect(input.getWorkingMemory).toHaveBeenCalledWith({ threadId, resourceId });
  });

  it('returns a safe validation failure for malformed stored data', async () => {
    const input = fakeMemory('{"members":{"telegram:user:1":{"unknown":true}}}');
    const memory = createMemoryPort(input);

    const result = await memory.readWorkingMemory({ threadId, resourceId });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('Expected Working Memory read failure');
    expect(result.error).toBeInstanceOf(PlusOneError);
    expect(result.error.code).toBe('working_memory_read_failed');
    expect(result.error.category).toBe('validation_rejected');
    expect(result.error.retry).toBe('never');
    expect(result.outcome).toMatchObject({
      operation: 'read',
      status: 'failed',
      code: 'working_memory_read_failed',
      category: 'validation_rejected',
      retry: 'never',
    });
    expect(JSON.stringify(result.outcome)).not.toContain('unknown');
  });

  it('deep-merges objects, replaces arrays, and deletes null fields before writing', async () => {
    const initial = {
      savingPreferences: {
        priorities: ['Emergency fund'],
        constraints: ['Keep cash liquid'],
      },
      conventions: {
        groceryCategory: 'Groceries',
        oldConvention: 'Remove me',
      },
      members: {
        'telegram:user:1': { nickname: 'Alex' },
      },
    };
    const input = fakeMemory(JSON.stringify(initial));
    const memory = createMemoryPort(input);

    const result = await memory.applyWorkingMemoryPatch({
      threadId,
      resourceId,
      patch: {
        savingPreferences: {
          priorities: ['Home repairs'],
          constraints: null,
        },
        conventions: {
          oldConvention: null,
          expenseCategory: 'Dining out',
        },
        members: {
          'telegram:user:1': { communication: { tone: 'warm' } },
        },
      },
    });

    expect(result).toMatchObject({
      operation: 'update',
      status: 'succeeded',
      code: 'working_memory_update_succeeded',
    });
    expect(input.updateWorkingMemory).toHaveBeenCalledWith({
      threadId,
      resourceId,
      workingMemory: JSON.stringify({
        savingPreferences: { priorities: ['Home repairs'] },
        conventions: { groceryCategory: 'Groceries', expenseCategory: 'Dining out' },
        members: { 'telegram:user:1': { nickname: 'Alex', communication: { tone: 'warm' } } },
      }),
    });
  });

  it('rejects an invalid merged document before attempting a write', async () => {
    const input = fakeMemory(JSON.stringify({}));
    const memory = createMemoryPort(input);

    const result = await memory.applyWorkingMemoryPatch({
      threadId,
      resourceId,
      patch: {
        savingPreferences: { priorities: Array.from({ length: 21 }, () => 'too many') },
      } as never,
    });

    expect(result).toMatchObject({
      operation: 'update',
      status: 'failed',
      code: 'working_memory_update_rejected',
      category: 'validation_rejected',
      retry: 'never',
    });
    expect(input.updateWorkingMemory).not.toHaveBeenCalled();
  });

  it('clears every top-level category by writing the merged empty document', async () => {
    const input = fakeMemory(JSON.stringify({
      goals: { emergencyFund: { summary: 'Build a reserve' } },
      savingPreferences: { style: 'balanced' },
      communication: { detail: 'concise' },
      conventions: { groceryCategory: 'Groceries' },
      members: { 'telegram:user:1': { nickname: 'Alex' } },
    }));
    const memory = createMemoryPort(input);

    await expect(memory.clearWorkingMemory({ threadId, resourceId })).resolves.toMatchObject({
      operation: 'clear',
      status: 'succeeded',
      code: 'working_memory_clear_succeeded',
    });
    expect(input.updateWorkingMemory).toHaveBeenCalledWith({
      threadId,
      resourceId,
      workingMemory: '{}',
    });
  });

  it('closes an injected memory boundary idempotently', async () => {
    const input = fakeMemory();
    const close = vi.fn(async () => undefined);
    const memory = createOrchestratorSessionMemory({ memory: input.memory, close });

    await memory.close();
    await memory.close();

    expect(close).toHaveBeenCalledOnce();
  });
});
