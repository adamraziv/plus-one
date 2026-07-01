import { describe, expect, it, vi } from 'vitest';
import type { MastraDBMessage } from '@mastra/core/agent';
import { InboundChannelMessageSchemaV1 } from '@plus-one/contracts';
import {
  createOrchestratorSessionMemory,
  orchestratorSessionMemoryOptions,
  type OrchestratorSessionMemoryStore,
} from '../src/memory/orchestrator-session-memory.js';

function text(message: MastraDBMessage) {
  return message.content.parts
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function dbMessage(role: 'system' | 'user' | 'assistant', body: string): MastraDBMessage {
  return {
    id: `${role}-${body}`,
    role,
    createdAt: new Date('2026-06-30T00:00:00.000Z'),
    content: { format: 2, parts: [{ type: 'text', text: body }] },
  };
}

function inboundMessage(overrides: Partial<ReturnType<typeof InboundChannelMessageSchemaV1.parse>> = {}) {
  return InboundChannelMessageSchemaV1.parse({
    schemaName: 'inbound-channel-message',
    schemaVersion: 1,
    conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    channel: 'telegram',
    externalMessageId: 'telegram-message-1',
    receivedAt: '2026-06-30T00:00:00.000Z',
    speaker: { principalRef: 'telegram:user:test', displayName: 'Test User' },
    body: 'Use checking for that transfer.',
    attachments: [],
    metadata: { destination: { chatId: 'chat-1' } },
    ...overrides,
  });
}

describe('createOrchestratorSessionMemory', () => {
  it('enables thread-scoped observational memory for the orchestrator session store', () => {
    expect(orchestratorSessionMemoryOptions({
      id: 'openai/gpt-4.1-mini',
      endpoint: 'https://llm.example.test/v1',
      apiKey: 'test-api-key',
    })).toMatchObject({
      lastMessages: 20,
      semanticRecall: false,
      workingMemory: { enabled: false },
      observationalMemory: {
        model: {
          id: 'openai/gpt-4.1-mini',
          url: 'https://llm.example.test/v1',
          apiKey: 'test-api-key',
        },
        scope: 'thread',
        retrieval: { scope: 'thread' },
      },
    });
  });

  it('builds the current user turn from the inbound message body', async () => {
    const store: OrchestratorSessionMemoryStore = {
      getContext: vi.fn(async () => ({
        systemMessage: undefined,
        messages: [dbMessage('assistant', 'Earlier clean reply')],
      })),
      saveMessages: vi.fn(),
      close: vi.fn(),
    };
    const memory = createOrchestratorSessionMemory({ store });
    const message = inboundMessage();

    const messages = await memory.prepareInput({ message });

    expect(store.getContext).toHaveBeenCalledWith({
      threadId: message.conversationId,
      resourceId: message.householdId,
    });
    expect(messages.map((entry) => [entry.role, text(entry)])).toEqual([
      ['assistant', 'Earlier clean reply'],
      ['user', 'Use checking for that transfer.'],
    ]);
  });

  it('reuses the same persisted message ids when the same inbound message is saved twice', async () => {
    const saveMessages = vi.fn();
    const store: OrchestratorSessionMemoryStore = {
      getContext: vi.fn(),
      saveMessages,
      close: vi.fn(),
    };
    const memory = createOrchestratorSessionMemory({ store });
    const message = inboundMessage({ body: 'Record a $10 burger.' });

    await memory.persistTurn({
      message,
      assistantText: 'Which account should I use?',
    });
    await memory.persistTurn({
      message,
      assistantText: 'Which account should I use?',
    });

    const first = saveMessages.mock.calls[0]?.[0].messages as MastraDBMessage[];
    const second = saveMessages.mock.calls[1]?.[0].messages as MastraDBMessage[];

    expect(second.map((entry) => entry.id)).toEqual(first.map((entry) => entry.id));
    expect(first.map((entry) => [entry.role, text(entry)])).toEqual([
      ['user', 'Record a $10 burger.'],
      ['assistant', 'Which account should I use?'],
    ]);
  });
});
