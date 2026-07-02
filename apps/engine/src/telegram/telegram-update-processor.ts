import { InboundChannelMessageSchemaV1, type InboundChannelMessageV1 } from '@plus-one/contracts';
import type { ChannelPrincipalRecord, TelegramPairingService } from '@plus-one/runtime';

export interface TelegramMessageUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    chat: { id: number | string; type: string };
    from?: {
      id: number | string;
      is_bot?: boolean;
      first_name?: string;
      last_name?: string;
      username?: string;
    };
  };
}

export type TelegramUpdateResult =
  | { status: 'ignored'; reason: 'unsupported_update' | 'non_private_chat' | 'unsupported_message_type' | 'missing_sender' }
  | { status: 'pairing-required' }
  | unknown;

interface ConversationRepository {
  resolveActiveConversation(input: {
    householdId: string;
    channel: 'telegram';
    externalConversationId: string;
    externalThreadId?: string;
  }): Promise<{ conversationId: string } | undefined>;
  startNewConversation(input: {
    householdId: string;
    conversationId: string;
    channel: 'telegram';
    channelType: 'direct';
    externalConversationId: string;
    destination: Record<string, unknown>;
  }): Promise<{ conversationId: string }>;
}

interface TelegramSender {
  sendMessage(input: { chatId: string; text: string }): Promise<{ platformMessageId: string }>;
}

export class TelegramUpdateProcessor {
  constructor(private readonly input: {
    pairing: Pick<TelegramPairingService, 'findPrincipal' | 'createPairingRequest'>;
    deliveryRepository: ConversationRepository;
    inboundHandler: (message: InboundChannelMessageV1) => Promise<unknown>;
    telegram: TelegramSender;
    ids: { nextConversationId(): string };
  }) {}

  async handle(update: TelegramMessageUpdate): Promise<TelegramUpdateResult> {
    const message = update.message;
    if (message === undefined) return { status: 'ignored', reason: 'unsupported_update' };
    if (message.chat.type !== 'private') return { status: 'ignored', reason: 'non_private_chat' };
    if (message.text === undefined || message.text.trim().length === 0) {
      return { status: 'ignored', reason: 'unsupported_message_type' };
    }
    if (message.from === undefined) return { status: 'ignored', reason: 'missing_sender' };

    const externalUserId = String(message.from.id);
    const externalChatId = String(message.chat.id);
    const displayName = displayNameFrom(message.from);
    const principal = await this.input.pairing.findPrincipal(externalUserId);
    if (principal === undefined) {
      const pairing = await this.input.pairing.createPairingRequest({
        externalUserId,
        externalChatId,
        ...(displayName === undefined ? {} : { displayName }),
        ...(message.from.username === undefined ? {} : { username: message.from.username }),
        metadata: {
          updateId: String(update.update_id),
          messageId: String(message.message_id),
        },
      });
      if (pairing.status === 'rate-limited') {
        await this.input.telegram.sendMessage({
          chatId: externalChatId,
          text: `A pairing code was sent recently. Try again after ${pairing.retryAfter}.`,
        });
        return { status: 'pairing-required' };
      }
      if (pairing.status === 'too-many-pending') {
        await this.input.telegram.sendMessage({
          chatId: externalChatId,
          text: 'Too many pairing requests right now. Please try again later.',
        });
        return { status: 'pairing-required' };
      }
      await this.input.telegram.sendMessage({
        chatId: externalChatId,
        text: `Pair this Telegram account with Plus One using code ${pairing.code}. Give this code to your household admin. It expires at ${pairing.expiresAt}.`,
      });
      return { status: 'pairing-required' };
    }

    const conversation = await resolveConversation(this.input, principal, externalChatId);
    const inbound = InboundChannelMessageSchemaV1.parse({
      schemaName: 'inbound-channel-message',
      schemaVersion: 1,
      conversationId: conversation.conversationId,
      householdId: principal.householdId,
      channel: 'telegram',
      externalMessageId: `telegram:${externalChatId}:${message.message_id}`,
      receivedAt: new Date(message.date * 1000).toISOString(),
      speaker: {
        principalRef: `telegram:user:${externalUserId}`,
        ...(displayName === undefined ? {} : { displayName }),
      },
      body: message.text,
      attachments: [],
      metadata: {
        updateId: String(update.update_id),
        destination: { chatId: externalChatId },
        telegramUserId: externalUserId,
      },
    });
    const result = await this.input.inboundHandler(inbound);
    if (isCommandHandled(result)) {
      await this.input.telegram.sendMessage({ chatId: externalChatId, text: result.body });
    }
    return result;
  }
}

function isCommandHandled(result: unknown): result is { status: 'command-handled'; body: string } {
  return typeof result === 'object'
    && result !== null
    && (result as { status?: unknown }).status === 'command-handled'
    && typeof (result as { body?: unknown }).body === 'string';
}

async function resolveConversation(
  input: {
    deliveryRepository: ConversationRepository;
    ids: { nextConversationId(): string };
  },
  principal: ChannelPrincipalRecord,
  externalChatId: string,
): Promise<{ conversationId: string }> {
  const active = await input.deliveryRepository.resolveActiveConversation({
    householdId: principal.householdId,
    channel: 'telegram',
    externalConversationId: externalChatId,
  });
  if (active !== undefined) return active;
  return input.deliveryRepository.startNewConversation({
    householdId: principal.householdId,
    conversationId: input.ids.nextConversationId(),
    channel: 'telegram',
    channelType: 'direct',
    externalConversationId: externalChatId,
    destination: { chatId: externalChatId },
  });
}

function displayNameFrom(user: {
  first_name?: string;
  last_name?: string;
  username?: string;
}): string | undefined {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  if (name.length > 0) return name;
  return user.username;
}
