import { createHash, randomUUID } from 'node:crypto';
import type { MastraDBMessage } from '@mastra/core/agent';
import type { InboundChannelMessageV1 } from '@plus-one/contracts';
import { Memory } from '@mastra/memory';
import { createMastraMemoryStorage } from '@plus-one/database';
import { toMastraModel, type EngineLlmModelConfig } from '../mastra/role-agent.js';

const ORCHESTRATOR_LAST_MESSAGES = 20;
type OrchestratorMemoryOptions = NonNullable<NonNullable<ConstructorParameters<typeof Memory>[0]>['options']>;

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
  prepareInput(input: { message: InboundChannelMessageV1 }): Promise<MastraDBMessage[]>;
  persistTurn(input: { message: InboundChannelMessageV1; assistantText: string }): Promise<void>;
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
    options: orchestratorSessionMemoryOptions(input.model),
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

  async prepareInput(input: { message: InboundChannelMessageV1 }): Promise<MastraDBMessage[]> {
    const message = input.message;
    const context = await this.store.getContext({
      threadId: message.conversationId,
      resourceId: message.householdId,
    });
    return [
      ...(context.systemMessage === undefined ? [] : [chatMessage('system', context.systemMessage)]),
      ...context.messages,
      ...(context.continuationMessage === undefined ? [] : [context.continuationMessage]),
      chatMessage('user', message.body, message.conversationId, message.householdId),
    ];
  }

  async persistTurn(input: { message: InboundChannelMessageV1; assistantText: string }): Promise<void> {
    const message = input.message;
    await this.ensureThread(message.conversationId, message.householdId);
    const createdAt = new Date();
    await this.store.saveMessages({
      messages: [
        chatMessage(
          'user',
          message.body,
          message.conversationId,
          message.householdId,
          createdAt,
          stableMessageId(message, 'user'),
        ),
        chatMessage(
          'assistant',
          input.assistantText,
          message.conversationId,
          message.householdId,
          new Date(createdAt.getTime() + 1),
          stableMessageId(message, 'assistant'),
        ),
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

export function orchestratorSessionMemoryOptions(model: EngineLlmModelConfig): OrchestratorMemoryOptions {
  return {
    lastMessages: ORCHESTRATOR_LAST_MESSAGES,
    semanticRecall: false,
    workingMemory: { enabled: false },
    observationalMemory: {
      model: toMastraModel(model),
      scope: 'thread',
      retrieval: { scope: 'thread' },
    },
  };
}

function stableMessageId(message: InboundChannelMessageV1, role: 'user' | 'assistant'): ReturnType<typeof randomUUID> {
  const hex = createHash('sha256')
    .update(`${message.conversationId}\0${message.externalMessageId}\0${role}`)
    .digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-') as ReturnType<typeof randomUUID>;
}

function chatMessage(
  role: 'system' | 'user' | 'assistant',
  text: string,
  threadId?: string,
  resourceId?: string,
  createdAt = new Date(),
  id = randomUUID(),
): MastraDBMessage {
  return {
    id,
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
