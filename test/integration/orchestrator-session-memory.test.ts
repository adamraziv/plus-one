import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { InboundChannelMessageSchemaV1 } from '@plus-one/contracts';
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
  it('deduplicates repeated inbound persistence and keeps observational memory empty', async () => {
    context = await createPostgresTestContext('orchestrator_session_memory');
    const sessionMemory = createOrchestratorSessionMemory({
      connectionString: context.roleUrls.memory,
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
    });
    closables.push(sessionMemory);

    const message = InboundChannelMessageSchemaV1.parse({
      schemaName: 'inbound-channel-message',
      schemaVersion: 1,
      conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      channel: 'telegram',
      externalMessageId: 'telegram-message-1',
      receivedAt: '2026-06-30T00:00:00.000Z',
      speaker: { principalRef: 'telegram:user:test', displayName: 'Test User' },
      body: 'Remember tea as Groceries.',
      attachments: [],
      metadata: { destination: { chatId: 'chat-1' } },
    });

    await sessionMemory.persistTurn({
      message,
      assistantText: 'Noted. Tea is Groceries.',
    });
    await sessionMemory.persistTurn({
      message,
      assistantText: 'Noted. Tea is Groceries.',
    });

    const storage = createMastraMemoryStorage(context.roleUrls.memory);
    closables.push(storage as { close: () => Promise<void> });
    await storage.init();
    const memory = await storage.getStore('memory');
    const messages = await memory?.listMessages({ threadId: message.conversationId, page: 0, perPage: false });

    expect(messages?.messages.map((message) => ({
      role: message.role,
      text: textContent(message.content),
    }))).toEqual([
      { role: 'user', text: 'Remember tea as Groceries.' },
      { role: 'assistant', text: 'Noted. Tea is Groceries.' },
    ]);

    const pool = new Pool({ connectionString: context.roleUrls.memory });
    try {
      const rows = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM mastra_memory.mastra_observational_memory WHERE "threadId" = $1',
        [message.conversationId],
      );
      expect(rows.rows[0]?.count).toBe(0);
    } finally {
      await pool.end();
    }
  });
});

function textContent(content: { parts?: Array<{ type: string; text?: string }> }) {
  return content.parts
    ?.filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('') ?? '';
}
