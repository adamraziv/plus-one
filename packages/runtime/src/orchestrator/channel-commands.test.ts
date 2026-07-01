import { describe, expect, it, vi } from 'vitest';
import { InboundChannelMessageSchemaV1 } from '@plus-one/contracts';
import { ChannelCommandHandler } from './channel-commands.js';

const message = InboundChannelMessageSchemaV1.parse({
  schemaName: 'inbound-channel-message',
  schemaVersion: 1,
  conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  channel: 'telegram',
  externalMessageId: 'telegram-message-1',
  receivedAt: '2026-06-30T00:00:00.000Z',
  speaker: { principalRef: 'telegram:user:test', displayName: 'Test User' },
  body: '/new',
  attachments: [],
  metadata: { destination: { chatId: 'telegram-chat-42' } },
});

describe('ChannelCommandHandler', () => {
  it('starts a new Telegram conversation for /new', async () => {
    const startNewConversation = vi.fn(async () => ({
      conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J2K',
    }));
    const handler = new ChannelCommandHandler({
      repository: { startNewConversation },
      ids: { nextConversationId: () => 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J2K' },
      now: () => new Date('2026-06-30T00:01:00.000Z'),
    });

    await expect(handler.handle(message)).resolves.toMatchObject({
      command: 'new',
      status: 'handled',
      conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J2K',
      body: 'Started a new thread.',
    });
    expect(startNewConversation).toHaveBeenCalledWith({
      householdId: message.householdId,
      conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J2K',
      channel: 'telegram',
      channelType: 'direct',
      externalConversationId: 'telegram-chat-42',
      destination: { chatId: 'telegram-chat-42' },
    });
  });

  it('ignores normal Telegram messages', async () => {
    const handler = new ChannelCommandHandler({
      repository: { startNewConversation: vi.fn() },
      ids: { nextConversationId: () => 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J2K' },
    });

    await expect(handler.handle({ ...message, body: 'hello' })).resolves.toBeUndefined();
  });
});
