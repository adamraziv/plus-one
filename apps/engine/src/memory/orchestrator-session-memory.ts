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
    continuationMessage?: MastraDBMessage | undefined;
  }>;
  getThreadById?(input: { threadId: string; resourceId?: string }): Promise<unknown>;
  saveThread?(input: {
    thread: {
      id: string;
      resourceId: string;
      title: string;
      metadata: Record<string, unknown>;
      createdAt: Date;
      updatedAt: Date;
    };
  }): Promise<unknown>;
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
    getThreadById: (threadInput) => memory.getThreadById(threadInput),
    saveThread: (threadInput) => memory.saveThread(threadInput),
    saveMessages: (saveInput) => memory.saveMessages(saveInput),
    close: async () => {
      await storage.close?.();
    },
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
    await this.ensureThread(input.threadId, input.resourceId);
    const createdAt = new Date();
    await this.store.saveMessages({
      messages: [
        chatMessage('user', input.userText, input.threadId, input.resourceId, createdAt),
        chatMessage('assistant', input.assistantText, input.threadId, input.resourceId, new Date(createdAt.getTime() + 1)),
      ],
    });
  }

  async close(): Promise<void> {
    await this.store.close?.();
  }

  private async ensureThread(threadId: string, resourceId: string): Promise<void> {
    const getThreadById = this.store.getThreadById;
    const saveThread = this.store.saveThread;
    if (getThreadById === undefined || saveThread === undefined) return;
    if (await getThreadById({ threadId, resourceId }) !== null) return;
    const now = new Date();
    await saveThread({
      thread: {
        id: threadId,
        resourceId,
        title: 'Orchestrator conversation',
        metadata: {},
        createdAt: now,
        updatedAt: now,
      },
    });
  }
}

function chatMessage(
  role: 'system' | 'user' | 'assistant',
  text: string,
  threadId?: string,
  resourceId?: string,
  createdAt = new Date(),
): MastraDBMessage {
  return {
    id: randomUUID(),
    role,
    createdAt,
    ...(threadId === undefined ? {} : { threadId }),
    ...(resourceId === undefined ? {} : { resourceId }),
    content: {
      format: 2,
      parts: [{ type: 'text', text }],
    },
  };
}
