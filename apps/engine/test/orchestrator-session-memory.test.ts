import { describe, expect, it, vi } from 'vitest';
import type { MastraDBMessage } from '@mastra/core/agent';
import {
  createOrchestratorSessionMemory,
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

describe('createOrchestratorSessionMemory', () => {
  it('loads thread context and appends the current user turn', async () => {
    const store: OrchestratorSessionMemoryStore = {
      getContext: vi.fn(async () => ({
        systemMessage: 'Condensed thread context',
        messages: [dbMessage('assistant', 'Earlier clean reply')],
        hasObservations: true,
        omRecord: null,
        continuationMessage: undefined,
        otherThreadsContext: undefined,
      })),
      saveMessages: vi.fn(),
      close: vi.fn(),
    };
    const memory = createOrchestratorSessionMemory({ store });

    const messages = await memory.prepareInput({
      threadId: 'conversation_01',
      resourceId: 'hh_01',
      userText: 'Use checking for that transfer.',
    });

    expect(store.getContext).toHaveBeenCalledWith({
      threadId: 'conversation_01',
      resourceId: 'hh_01',
    });
    expect(messages.map((message) => [message.role, text(message)])).toEqual([
      ['system', 'Condensed thread context'],
      ['assistant', 'Earlier clean reply'],
      ['user', 'Use checking for that transfer.'],
    ]);
  });

  it('persists only the clean user and final assistant turns', async () => {
    const saveMessages = vi.fn();
    const store: OrchestratorSessionMemoryStore = {
      getContext: vi.fn(),
      saveMessages,
      close: vi.fn(),
    };
    const memory = createOrchestratorSessionMemory({ store });

    await memory.persistTurn({
      threadId: 'conversation_01',
      resourceId: 'hh_01',
      userText: 'Record a $10 burger.',
      assistantText: 'Which account should I use?',
    });

    const saved = saveMessages.mock.calls[0]?.[0].messages as MastraDBMessage[];
    expect(saved.map((message) => [message.role, text(message)])).toEqual([
      ['user', 'Record a $10 burger.'],
      ['assistant', 'Which account should I use?'],
    ]);
  });
});
