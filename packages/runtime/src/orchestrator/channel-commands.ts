import {
  ChannelCommandResultSchemaV1,
  ConversationIdSchema,
  type ChannelCommandResultV1,
  type InboundChannelMessageV1,
} from '@plus-one/contracts';
import { ulid } from 'ulid';

export interface ChannelCommandRepository {
  startNewConversation(input: {
    householdId: string;
    conversationId: string;
    channel: 'telegram' | 'slack';
    channelType: 'direct' | 'group' | 'channel' | 'thread';
    externalConversationId: string;
    externalThreadId?: string;
    destination: Record<string, unknown>;
  }): Promise<{ conversationId: string }>;
}

export interface ConversationIdGenerator {
  nextConversationId(): string;
}

export const defaultConversationIdGenerator: ConversationIdGenerator = {
  nextConversationId: () => ConversationIdSchema.parse(`conversation_${ulid()}`),
};

export class ChannelCommandHandler {
  constructor(private readonly dependencies: {
    repository: ChannelCommandRepository;
    ids: ConversationIdGenerator;
    now?: () => Date;
  }) {}

  async handle(message: InboundChannelMessageV1): Promise<ChannelCommandResultV1 | undefined> {
    if (message.channel !== 'telegram') return undefined;
    if (!isNewCommand(message.body)) return undefined;

    const destination = destinationFromMessage(message);
    const externalConversationId = externalConversationIdFromDestination(destination);
    const externalThreadId = externalThreadIdFromMessage(message);
    const conversation = await this.dependencies.repository.startNewConversation({
      householdId: message.householdId,
      conversationId: this.dependencies.ids.nextConversationId(),
      channel: message.channel,
      channelType: externalThreadId === undefined ? 'direct' : 'thread',
      externalConversationId,
      ...(externalThreadId === undefined ? {} : { externalThreadId }),
      destination,
    });

    return ChannelCommandResultSchemaV1.parse({
      schemaName: 'channel-command-result',
      schemaVersion: 1,
      command: 'new',
      status: 'handled',
      householdId: message.householdId,
      conversationId: conversation.conversationId,
      channel: message.channel,
      delivery: { channel: message.channel, destination, format: 'plain_text' },
      body: 'Started a new thread.',
      createdAt: (this.dependencies.now ?? (() => new Date()))().toISOString(),
    });
  }
}

function isNewCommand(body: string): boolean {
  const trimmed = body.trim();
  return trimmed === '/new' || trimmed.startsWith('/new ');
}

function destinationFromMessage(message: InboundChannelMessageV1): Record<string, unknown> {
  const destination = message.metadata.destination;
  if (destination !== null && typeof destination === 'object' && !Array.isArray(destination)) return destination;
  return { chatId: '' };
}

function externalConversationIdFromDestination(destination: Record<string, unknown>): string {
  const chatId = destination.chatId;
  if (typeof chatId === 'string' && chatId.length > 0) return chatId;
  throw new Error('telegram_chat_id_missing');
}

function externalThreadIdFromMessage(message: InboundChannelMessageV1): string | undefined {
  const threadId = message.metadata.externalThreadId;
  return typeof threadId === 'string' && threadId.length > 0 ? threadId : undefined;
}
