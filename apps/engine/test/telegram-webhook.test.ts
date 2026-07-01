import { describe, expect, it, vi } from 'vitest';
import { createTelegramWebhookRoute } from '../src/telegram/telegram-webhook.js';

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

function context(input: {
  body: unknown;
  secret?: string;
}) {
  const json = vi.fn((body: unknown, status?: number) => ({ body, status }));
  return {
    req: {
      json: vi.fn(async () => input.body),
      header: vi.fn((name: string) => name.toLowerCase() === 'x-telegram-bot-api-secret-token'
        ? input.secret
        : undefined),
    },
    json,
  };
}

function handlerOf(route: unknown): (context: unknown) => Promise<unknown> {
  return (route as { handler(context: unknown): Promise<unknown> }).handler;
}

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

describe('Telegram webhook route', () => {
  it('rejects requests with a bad Telegram webhook secret', async () => {
    const route = createTelegramWebhookRoute({
      webhookSecret: 'secret',
      pairing: {
        findPrincipal: vi.fn(),
        createPairingRequest: vi.fn(),
      },
      deliveryRepository: {} as never,
      inboundHandler: vi.fn(),
      telegram: { sendMessage: vi.fn() },
      ids: { nextConversationId: vi.fn() },
    });

    await expect(handlerOf(route)(context({ body: {}, secret: 'bad' }))).resolves.toEqual({
      body: { error: 'telegram_webhook_secret_invalid' },
      status: 401,
    });
  });

  it('acknowledges non-private updates without orchestration', async () => {
    const inboundHandler = vi.fn();
    const route = createTelegramWebhookRoute({
      webhookSecret: 'secret',
      pairing: {
        findPrincipal: vi.fn(),
        createPairingRequest: vi.fn(),
      },
      deliveryRepository: {} as never,
      inboundHandler,
      telegram: { sendMessage: vi.fn() },
      ids: { nextConversationId: vi.fn() },
    });

    await expect(handlerOf(route)(context({
      secret: 'secret',
      body: {
        update_id: 1,
        message: {
          message_id: 42,
          date: 1782864000,
          chat: { id: -100, type: 'group' },
          from: { id: 1234567890123, is_bot: false, first_name: 'Ada' },
          text: 'hello',
        },
      },
    }) as never)).resolves.toEqual({
      body: { status: 'ignored', reason: 'non_private_chat' },
      status: undefined,
    });
    expect(inboundHandler).not.toHaveBeenCalled();
  });

  it('sends a pairing code for an unknown private DM and skips orchestration', async () => {
    const sendMessage = vi.fn(async () => ({ platformMessageId: 'telegram-platform-1' }));
    const inboundHandler = vi.fn();
    const route = createTelegramWebhookRoute({
      webhookSecret: 'secret',
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

    await expect(handlerOf(route)(context({
      secret: 'secret',
      body: privateTextUpdate('/start'),
    }) as never)).resolves.toMatchObject({
      body: { status: 'pairing-required' },
    });
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: '9876543210987',
      text: expect.stringContaining('ABCDEFGH'),
    });
    expect(inboundHandler).not.toHaveBeenCalled();
  });

  it('throttles repeated pairing replies for an unknown private DM', async () => {
    const sendMessage = vi.fn(async () => ({ platformMessageId: 'telegram-platform-1' }));
    const route = createTelegramWebhookRoute({
      webhookSecret: 'secret',
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

    await expect(handlerOf(route)(context({
      secret: 'secret',
      body: privateTextUpdate('/start'),
    }) as never)).resolves.toMatchObject({
      body: { status: 'pairing-required' },
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
    const route = createTelegramWebhookRoute({
      webhookSecret: 'secret',
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

    await expect(handlerOf(route)(context({
      secret: 'secret',
      body: privateTextUpdate('How are we doing?'),
    }) as never)).resolves.toEqual({
      body: { status: 'ok' },
      status: undefined,
    });
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
      externalMessageId: 'telegram:42',
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
});
