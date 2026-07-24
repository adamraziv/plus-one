import { afterEach, describe, expect, it } from 'vitest';
import { createMastraMemoryStorage } from '@plus-one/database';
import { createOrchestratorSessionMemory } from '../../apps/engine/src/memory/orchestrator-session-memory.js';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

const model = {
  id: 'provider/orchestrator',
  endpoint: 'https://llm.example.test/v1',
  apiKey: 'test-api-key',
};
const resourceId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const otherResourceId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J2K';
const firstThreadId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H1K';
const secondThreadId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2K';

let context: PostgresTestContext | undefined;
const closables: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (closables.length > 0) {
    await closables.pop()?.close();
  }
  await context?.cleanup();
  context = undefined;
});

describe('orchestrator session memory', () => {
  it('shares resource-scoped Working Memory across threads and isolates resources', async () => {
    context = await createPostgresTestContext('orchestrator_working_memory_scope');
    const first = createOrchestratorSessionMemory({
      connectionString: context.roleUrls.memory,
      model,
    });
    closables.push(first);

    await expect(first.applyWorkingMemoryPatch({
      threadId: firstThreadId,
      resourceId,
      patch: {
        goals: { emergencyFund: { summary: 'Build a reserve', priority: 'high' } },
        members: { 'telegram:user:test': { nickname: 'Alex' } },
      },
    })).resolves.toMatchObject({ status: 'succeeded' });

    const second = createOrchestratorSessionMemory({
      connectionString: context.roleUrls.memory,
      model,
    });
    closables.push(second);

    await expect(second.readWorkingMemory({
      threadId: secondThreadId,
      resourceId,
    })).resolves.toMatchObject({
      status: 'succeeded',
      value: {
        goals: { emergencyFund: { summary: 'Build a reserve', priority: 'high' } },
        members: { 'telegram:user:test': { nickname: 'Alex' } },
      },
    });
    await expect(second.readWorkingMemory({
      threadId: secondThreadId,
      resourceId: otherResourceId,
    })).resolves.toMatchObject({ status: 'succeeded', value: {} });
  });

  it('persists documented merge, replacement, deletion, and clear semantics', async () => {
    context = await createPostgresTestContext('orchestrator_working_memory_merge');
    const memory = createOrchestratorSessionMemory({
      connectionString: context.roleUrls.memory,
      model,
    });
    closables.push(memory);

    await memory.applyWorkingMemoryPatch({
      threadId: firstThreadId,
      resourceId,
      patch: {
        savingPreferences: {
          priorities: ['Emergency fund'],
          constraints: ['Keep cash liquid'],
        },
        conventions: { groceryCategory: 'Groceries', oldConvention: 'Remove me' },
      },
    });
    await memory.applyWorkingMemoryPatch({
      threadId: secondThreadId,
      resourceId,
      patch: {
        savingPreferences: { priorities: ['Home repairs'], constraints: null },
        conventions: { oldConvention: null, expenseCategory: 'Dining out' },
      },
    });

    await expect(memory.readWorkingMemory({ threadId: firstThreadId, resourceId })).resolves.toMatchObject({
      status: 'succeeded',
      value: {
        savingPreferences: { priorities: ['Home repairs'] },
        conventions: { groceryCategory: 'Groceries', expenseCategory: 'Dining out' },
      },
    });

    await expect(memory.clearWorkingMemory({ threadId: firstThreadId, resourceId })).resolves.toMatchObject({
      status: 'succeeded',
      code: 'working_memory_clear_succeeded',
    });
    await expect(memory.readWorkingMemory({ threadId: secondThreadId, resourceId })).resolves.toMatchObject({
      status: 'succeeded',
      value: {},
    });
  });

  it('rejects invalid bounded updates without changing the previous resource state', async () => {
    context = await createPostgresTestContext('orchestrator_working_memory_validation');
    const memory = createOrchestratorSessionMemory({
      connectionString: context.roleUrls.memory,
      model,
    });
    closables.push(memory);

    await memory.applyWorkingMemoryPatch({
      threadId: firstThreadId,
      resourceId,
      patch: { communication: { detail: 'concise' } },
    });
    const invalid = await memory.applyWorkingMemoryPatch({
      threadId: firstThreadId,
      resourceId,
      patch: {
        savingPreferences: { priorities: Array.from({ length: 21 }, () => 'too many') },
      } as never,
    });

    expect(invalid).toMatchObject({
      status: 'failed',
      code: 'working_memory_update_rejected',
      category: 'validation_rejected',
      retry: 'never',
    });
    await expect(memory.readWorkingMemory({ threadId: firstThreadId, resourceId })).resolves.toMatchObject({
      status: 'succeeded',
      value: { communication: { detail: 'concise' } },
    });
  });

  it('does not write a manual transcript while native Working Memory persists', async () => {
    context = await createPostgresTestContext('orchestrator_working_memory_transcript');
    const memory = createOrchestratorSessionMemory({
      connectionString: context.roleUrls.memory,
      model,
    });
    closables.push(memory);
    await memory.applyWorkingMemoryPatch({
      threadId: firstThreadId,
      resourceId,
      patch: { conventions: { groceryCategory: 'Groceries' } },
    });

    const storage = createMastraMemoryStorage(context.roleUrls.memory);
    closables.push(storage as { close: () => Promise<void> });
    await storage.init();
    const memoryStore = await storage.getStore('memory');
    const messages = await memoryStore?.listMessages({
      threadId: firstThreadId,
      page: 0,
      perPage: false,
    });

    expect(messages?.messages).toEqual([]);
  });
});
