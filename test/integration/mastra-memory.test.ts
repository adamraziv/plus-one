import { afterEach, describe, expect, it } from 'vitest';
import { createMastraMemoryStorage } from '@plus-one/database';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;
const storages: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (storages.length > 0) {
    await storages.pop()?.close();
  }
  await context?.cleanup();
  context = undefined;
});

describe('Mastra memory storage', () => {
  it('persists resources, threads, and messages across fresh storage instances', async () => {
    context = await createPostgresTestContext('mastra_memory');
    const createdAt = new Date('2026-06-22T00:00:00.000Z');
    const secondMessageAt = new Date('2026-06-22T00:01:00.000Z');
    const updatedAt = new Date('2026-06-22T00:05:00.000Z');

    const first = createMastraMemoryStorage(context.roleUrls.memory);
    storages.push(first as { close: () => Promise<void> });
    await first.init();
    const memoryStore = await first.getStore('memory');
    await memoryStore?.saveResource({
      resource: {
        id: 'household_01',
        workingMemory: 'Budget review context',
        metadata: { householdId: 'hh_01' },
        createdAt,
        updatedAt,
      },
    });
    await memoryStore?.saveThread({
      thread: {
        id: 'thread_01',
        resourceId: 'household_01',
        title: 'Quarterly budget check-in',
        metadata: { channel: 'telegram', externalThreadId: 'tg-thread-1' },
        createdAt,
        updatedAt,
      },
    });
    await memoryStore?.saveMessages({
      messages: [
        {
          id: 'msg_01',
          threadId: 'thread_01',
          resourceId: 'household_01',
          role: 'user',
          content: { format: 2, parts: [{ type: 'text', text: 'How did we do this month?' }] },
          createdAt,
        },
        {
          id: 'msg_02',
          threadId: 'thread_01',
          resourceId: 'household_01',
          role: 'assistant',
          content: { format: 2, parts: [{ type: 'text', text: 'You were under budget.' }] },
          createdAt: secondMessageAt,
        },
      ],
    });
    await memoryStore?.saveMessages({
      messages: [
        {
          id: 'msg_02',
          threadId: 'thread_01',
          resourceId: 'household_01',
          role: 'assistant',
          content: { format: 2, parts: [{ type: 'text', text: 'You were under budget.' }] },
          createdAt: secondMessageAt,
        },
      ],
    });

    const second = createMastraMemoryStorage(context.roleUrls.memory);
    storages.push(second as { close: () => Promise<void> });
    await second.init();
    const reloaded = await second.getStore('memory');
    const resource = await reloaded?.getResourceById({ resourceId: 'household_01' });
    const thread = await reloaded?.getThreadById({ threadId: 'thread_01' });
    const messages = await reloaded?.listMessages({ threadId: 'thread_01', page: 0, perPage: false });
    const duplicateLookup = await reloaded?.listMessagesById({ messageIds: ['msg_02', 'msg_02'] });
    const checkerThreadMessages = await reloaded?.listMessages({
      threadId: 'checker_thread_01',
      page: 0,
      perPage: false,
    });

    expect(resource?.id).toBe('household_01');
    expect(thread?.id).toBe('thread_01');
    expect(messages?.messages.map((message) => message.id)).toEqual(['msg_01', 'msg_02']);
    expect(duplicateLookup?.messages.map((message) => message.id)).toEqual(['msg_02']);
    expect(checkerThreadMessages?.messages).toEqual([]);
  });

  it('persists workflow snapshots across fresh storage instances', async () => {
    context = await createPostgresTestContext('mastra_workflows');

    const first = createMastraMemoryStorage(context.roleUrls.memory);
    storages.push(first as { close: () => Promise<void> });
    await first.init();
    const workflows = await first.getStore('workflows');
    await workflows?.persistWorkflowSnapshot({
      workflowName: 'orchestrator-loop',
      runId: 'run_01',
      resourceId: 'conversation_01',
      snapshot: { status: 'suspended', payload: { question: 'Which account?' } } as never,
    });

    const second = createMastraMemoryStorage(context.roleUrls.memory);
    storages.push(second as { close: () => Promise<void> });
    await second.init();
    const reloaded = await second.getStore('workflows');
    const snapshot = await reloaded?.loadWorkflowSnapshot({
      workflowName: 'orchestrator-loop',
      runId: 'run_01',
    });

    expect(snapshot).toMatchObject({
      status: 'suspended',
      payload: { question: 'Which account?' },
    });
  });
});
