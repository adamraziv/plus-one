import { describe, expect, it, vi } from 'vitest';
import { createTelegramWebhookRoute } from '../src/telegram/telegram-webhook.js';

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

describe('Telegram webhook route', () => {
  it('rejects requests with a bad Telegram webhook secret', async () => {
    const route = createTelegramWebhookRoute({
      webhookSecret: 'secret',
      processor: { handle: vi.fn() },
    });

    await expect(handlerOf(route)(context({ body: {}, secret: 'bad' }))).resolves.toEqual({
      body: { error: 'telegram_webhook_secret_invalid' },
      status: 401,
    });
  });

  it('delegates authenticated updates to the shared processor', async () => {
    const processor = { handle: vi.fn(async () => ({ status: 'ignored', reason: 'unsupported_update' })) };
    const route = createTelegramWebhookRoute({ webhookSecret: 'secret', processor });

    await expect(handlerOf(route)(context({
      body: { update_id: 1 },
      secret: 'secret',
    }))).resolves.toEqual({
      body: { status: 'ignored', reason: 'unsupported_update' },
      status: undefined,
    });
    expect(processor.handle).toHaveBeenCalledWith({ update_id: 1 });
  });
});
