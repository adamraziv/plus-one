import { randomUUID } from 'node:crypto';
import type { MastraDBMessage } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { createMastraMemoryStorage } from '@plus-one/database';
import type { EngineLlmModelConfig } from '../mastra/role-agent.js';
import { toMastraModel } from '../mastra/role-agent.js';

const ORCHESTRATOR_LAST_MESSAGES = 20;

export interface OrchestratorSessionMemoryStore {
  getContext(input: { threadId: string; resourceId?: string }): Promise<{
    systemMessage: string | undefined;
    messages: MastraDBMessage[];
    continuationMessage?: MastraDBMessage;
  }>;
  saveMessages(input: { messages: MastraDBMessage[] }): Promise<unknown>;
  close?(): Promise<void>;
}

export interface OrchestratorSessionMemoryPort {
  prepareInput(input: {
    threadId: string;
    resourceId: string;
    userText: string;
  }): Promise<MastraDBMessage[]>;
  persistTurn(input: {
    threadId: string;
    resourceId: string;
    userText: string;
    assistantText: string;
  }): Promise<void>;
  close(): Promise<void>;
}

export function createOrchestratorSessionMemory(input:
  | { connectionString: string; model: EngineLlmModelConfig; store?: never }
  | { store: OrchestratorSessionMemoryStore; connectionString?: never; model?: never }
): OrchestratorSessionMemoryPort {
  if (input.store !== undefined) {
    return new OrchestratorSessionMemory(input.store);
  }

  const storage = createMastraMemoryStorage(input.connectionString);
  const memory = new Memory({
    storage,
    options: {
      lastMessages: ORCHESTRATOR_LAST_MESSAGES,
      semanticRecall: false,
      workingMemory: { enabled: false },
      observationalMemory: {
        scope: 'thread',
        model: toMastraModel(input.model),
      },
    },
  });

  return new OrchestratorSessionMemory({
    getContext: (contextInput) => memory.getContext(contextInput),
    saveMessages: (saveInput) => memory.saveMessages(saveInput),
    close: () => storage.close(),
  });
}

class OrchestratorSessionMemory implements OrchestratorSessionMemoryPort {
  constructor(private readonly store: OrchestratorSessionMemoryStore) {}

  async prepareInput(input: {
    threadId: string;
    resourceId: string;
    userText: string;
  }): Promise<MastraDBMessage[]> {
    const context = await this.store.getContext({
      threadId: input.threadId,
      resourceId: input.resourceId,
    });
    return [
      ...(context.systemMessage === undefined ? [] : [chatMessage('system', context.systemMessage)]),
      ...context.messages,
      ...(context.continuationMessage === undefined ? [] : [context.continuationMessage]),
      chatMessage('user', input.userText, input.threadId, input.resourceId),
    ];
  }

  async persistTurn(input: {
    threadId: string;
    resourceId: string;
    userText: string;
    assistantText: string;
  }): Promise<void> {
    await this.store.saveMessages({
      messages: [
        chatMessage('user', input.userText, input.threadId, input.resourceId),
        chatMessage('assistant', input.assistantText, input.threadId, input.resourceId),
      ],
    });
  }

  async close(): Promise<void> {
    await this.store.close?.();
  }
}

function chatMessage(
  role: 'system' | 'user' | 'assistant',
  text: string,
  threadId?: string,
  resourceId?: string,
): MastraDBMessage {
  return {
    id: randomUUID(),
    role,
    createdAt: new Date(),
    ...(threadId === undefined ? {} : { threadId }),
    ...(resourceId === undefined ? {} : { resourceId }),
    content: {
      format: 2,
      parts: [{ type: 'text', text }],
    },
  };
}
