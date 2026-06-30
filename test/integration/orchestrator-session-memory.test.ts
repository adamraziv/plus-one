import { afterEach, describe, expect, it } from 'vitest';
import { createMastraMemoryStorage } from '@plus-one/database';
import { createOrchestratorSessionMemory } from '../../apps/engine/src/memory/orchestrator-session-memory.js';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

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
  it('persists clean transcript turns separately from workflow snapshots', async () => {
    context = await createPostgresTestContext('orchestrator_session_memory');
    const sessionMemory = createOrchestratorSessionMemory({
      connectionString: context.roleUrls.memory,
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
    });
    closables.push(sessionMemory);

    await sessionMemory.persistTurn({
      threadId: 'conversation_01',
      resourceId: 'hh_01',
      userText: 'Record a $10 burger.',
      assistantText: 'Which account should I use?',
    });

    const storage = createMastraMemoryStorage(context.roleUrls.memory);
    closables.push(storage as { close: () => Promise<void> });
    await storage.init();
    const memory = await storage.getStore('memory');
    const workflows = await storage.getStore('workflows');

    await workflows?.persistWorkflowSnapshot({
      workflowName: 'orchestrator-loop',
      runId: 'run_01',
      resourceId: 'conversation_01',
      snapshot: { status: 'suspended', payload: { question: 'Which account?' } } as never,
    });

    const messages = await memory?.listMessages({ threadId: 'conversation_01', page: 0, perPage: false });
    const snapshot = await workflows?.loadWorkflowSnapshot({
      workflowName: 'orchestrator-loop',
      runId: 'run_01',
    });

    expect(messages?.messages.map((message) => ({
      role: message.role,
      text: textContent(message.content),
    }))).toEqual([
      { role: 'user', text: 'Record a $10 burger.' },
      { role: 'assistant', text: 'Which account should I use?' },
    ]);
    expect(snapshot).toMatchObject({
      status: 'suspended',
      payload: { question: 'Which account?' },
    });
  });
});

function textContent(content: { parts?: Array<{ type: string; text?: string }> }) {
  return content.parts
    ?.filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('') ?? '';
}
