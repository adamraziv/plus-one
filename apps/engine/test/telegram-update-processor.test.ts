import { describe, expect, it, vi } from 'vitest';
import { TelegramUpdateProcessor } from '../src/telegram/telegram-update-processor.js';

const pairedPrincipal = {
  id: 'principal-1',
  channel: 'telegram' as const,
  externalUserId: '1234567890123',
  externalChatId: '9876543210987',
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  displayName: 'Ada Lovelace',
  username: 'ada',
  approvedAt: '2026-07-01T00:00:00.000Z',
  approvedBy: 'cli:test',
  metadata: {},
};

function privateTextUpdate(text: string) {
  return {
    update_id: 1,
    message: {
      message_id: 42,
      date: 1782864000,
      chat: { id: 9876543210987, type: 'private' },
      from: {
        id: 1234567890123,
        is_bot: false,
        first_name: 'Ada',
        last_name: 'Lovelace',
        username: 'ada',
      },
      text,
    },
  };
}

describe('TelegramUpdateProcessor', () => {
  it('acknowledges unsupported update shapes without orchestration', async () => {
    const inboundHandler = vi.fn();
    const processor = new TelegramUpdateProcessor({
      pairing: {
        findPrincipal: vi.fn(),
        createPairingRequest: vi.fn(),
      },
      deliveryRepository: {} as never,
      inboundHandler,
      telegram: { sendMessage: vi.fn() },
      ids: { nextConversationId: vi.fn() },
    });

    await expect(processor.handle({ update_id: 1 })).resolves.toEqual({
      status: 'ignored',
      reason: 'unsupported_update',
    });
    expect(inboundHandler).not.toHaveBeenCalled();
  });

  it('acknowledges non-private updates without orchestration', async () => {
    const inboundHandler = vi.fn();
    const processor = new TelegramUpdateProcessor({
      pairing: {
        findPrincipal: vi.fn(),
        createPairingRequest: vi.fn(),
      },
      deliveryRepository: {} as never,
      inboundHandler,
      telegram: { sendMessage: vi.fn() },
      ids: { nextConversationId: vi.fn() },
    });

    await expect(processor.handle({
      update_id: 1,
      message: {
        message_id: 42,
        date: 1782864000,
        chat: { id: -100, type: 'group' },
        from: { id: 1234567890123, is_bot: false, first_name: 'Ada' },
        text: 'hello',
      },
    })).resolves.toEqual({ status: 'ignored', reason: 'non_private_chat' });
    expect(inboundHandler).not.toHaveBeenCalled();
  });

  it('sends a pairing code for an unknown private DM and skips orchestration', async () => {
    const sendMessage = vi.fn(async () => ({ platformMessageId: 'telegram-platform-1' }));
    const inboundHandler = vi.fn();
    const processor = new TelegramUpdateProcessor({
      pairing: {
        findPrincipal: vi.fn(async () => undefined),
        createPairingRequest: vi.fn(async () => ({
          status: 'created' as const,
          code: 'ABCDEFGH',
          expiresAt: '2026-07-01T01:00:00.000Z',
        })),
      },
      deliveryRepository: {} as never,
      inboundHandler,
      telegram: { sendMessage },
      ids: { nextConversationId: vi.fn() },
    });

    await expect(processor.handle(privateTextUpdate('/start'))).resolves.toMatchObject({
      status: 'pairing-required',
    });
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: '9876543210987',
      text: expect.stringContaining('ABCDEFGH'),
    });
    expect(inboundHandler).not.toHaveBeenCalled();
  });

  it('throttles repeated pairing replies for an unknown private DM', async () => {
    const sendMessage = vi.fn(async () => ({ platformMessageId: 'telegram-platform-1' }));
    const processor = new TelegramUpdateProcessor({
      pairing: {
        findPrincipal: vi.fn(async () => undefined),
        createPairingRequest: vi.fn(async () => ({
          status: 'rate-limited' as const,
          retryAfter: '2026-07-01T00:10:00.000Z',
        })),
      },
      deliveryRepository: {} as never,
      inboundHandler: vi.fn(),
      telegram: { sendMessage },
      ids: { nextConversationId: vi.fn() },
    });

    await expect(processor.handle(privateTextUpdate('/start'))).resolves.toMatchObject({
      status: 'pairing-required',
    });
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: '9876543210987',
      text: 'A pairing code was sent recently. Try again after 2026-07-01T00:10:00.000Z.',
    });
  });

  it('normalizes paired private text messages into inbound channel messages', async () => {
    const inboundHandler = vi.fn(async () => ({ status: 'ok' }));
    const startNewConversation = vi.fn(async () => ({
      conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    }));
    const processor = new TelegramUpdateProcessor({
      pairing: {
        findPrincipal: vi.fn(async () => pairedPrincipal),
        createPairingRequest: vi.fn(),
      },
      deliveryRepository: {
        resolveActiveConversation: vi.fn(async () => undefined),
        startNewConversation,
      },
      inboundHandler,
      telegram: { sendMessage: vi.fn() },
      ids: {
        nextConversationId: vi.fn(() => 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K'),
      },
    });

    await expect(processor.handle(privateTextUpdate('How are we doing?'))).resolves.toEqual({ status: 'ok' });
    expect(startNewConversation).toHaveBeenCalledWith({
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      channel: 'telegram',
      channelType: 'direct',
      externalConversationId: '9876543210987',
      destination: { chatId: '9876543210987' },
    });
    expect(inboundHandler).toHaveBeenCalledWith(expect.objectContaining({
      schemaName: 'inbound-channel-message',
      schemaVersion: 1,
      conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      channel: 'telegram',
      externalMessageId: 'telegram:9876543210987:42',
      speaker: {
        principalRef: 'telegram:user:1234567890123',
        displayName: 'Ada Lovelace',
      },
      body: 'How are we doing?',
      attachments: [],
      metadata: {
        updateId: '1',
        destination: { chatId: '9876543210987' },
        telegramUserId: '1234567890123',
      },
    }));
  });

  it('sends command-handled responses back to the paired Telegram chat', async () => {
    const sendMessage = vi.fn(async () => ({ platformMessageId: 'telegram-platform-2' }));
    const inboundHandler = vi.fn(async () => ({
      status: 'command-handled',
      command: 'new',
      body: 'Started a new thread.',
      conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J2K',
    }));
    const processor = new TelegramUpdateProcessor({
      pairing: {
        findPrincipal: vi.fn(async () => pairedPrincipal),
        createPairingRequest: vi.fn(),
      },
      deliveryRepository: {
        resolveActiveConversation: vi.fn(async () => ({
          conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        })),
        startNewConversation: vi.fn(),
      },
      inboundHandler,
      telegram: { sendMessage },
      ids: {
        nextConversationId: vi.fn(() => 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K'),
      },
    });

    await expect(processor.handle(privateTextUpdate('/new'))).resolves.toMatchObject({
      status: 'command-handled',
      body: 'Started a new thread.',
    });
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: '9876543210987',
      text: 'Started a new thread.',
    });
  });
});
