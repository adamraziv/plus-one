import { describe, expect, it, vi } from 'vitest';
import { TelegramBotApiClient, TelegramBotApiError } from '../src/telegram/telegram-bot-api.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('TelegramBotApiClient', () => {
  it('deletes a webhook without dropping pending updates', async () => {
    const fetch = vi.fn(async () => jsonResponse({ ok: true, result: true }));
    const client = new TelegramBotApiClient('token-123', fetch);

    await client.deleteWebhook({ dropPendingUpdates: false });

    expect(fetch).toHaveBeenCalledWith('https://api.telegram.org/bottoken-123/deleteWebhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ drop_pending_updates: false }),
    });
  });

  it('sets a webhook with secret token and message updates only', async () => {
    const fetch = vi.fn(async () => jsonResponse({ ok: true, result: true }));
    const client = new TelegramBotApiClient('token-123', fetch, { apiBaseUrl: 'http://127.0.0.1:9999' });

    await client.setWebhook({
      url: 'https://plus-one.example.test/telegram/webhook',
      secretToken: 'secret-123',
      allowedUpdates: ['message'],
      dropPendingUpdates: false,
    });

    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:9999/bottoken-123/setWebhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'https://plus-one.example.test/telegram/webhook',
        secret_token: 'secret-123',
        allowed_updates: ['message'],
        drop_pending_updates: false,
      }),
    });
  });

  it('gets updates with timeout, offset, and message update filter', async () => {
    const update = {
      update_id: 7,
      message: { message_id: 1, date: 1782864000, chat: { id: 1, type: 'private' } },
    };
    const fetch = vi.fn(async () => jsonResponse({ ok: true, result: [update] }));
    const client = new TelegramBotApiClient('token-123', fetch);

    await expect(client.getUpdates({ offset: 7, timeoutSeconds: 20, allowedUpdates: ['message'] }))
      .resolves.toEqual([update]);
    expect(fetch).toHaveBeenCalledWith('https://api.telegram.org/bottoken-123/getUpdates', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        offset: 7,
        timeout: 20,
        allowed_updates: ['message'],
      }),
    });
  });

  it('classifies Telegram 409 conflicts', async () => {
    const fetch = vi.fn(async () => jsonResponse({
      ok: false,
      description: 'Conflict: terminated by other getUpdates request',
    }, 409));
    const client = new TelegramBotApiClient('token-123', fetch);

    await expect(client.getUpdates({ timeoutSeconds: 20, allowedUpdates: ['message'] }))
      .rejects.toMatchObject({ code: 'telegram_polling_conflict', status: 409 });
  });

  it('throws TelegramBotApiError for non-conflict Telegram API failures', async () => {
    const fetch = vi.fn(async () => jsonResponse({ ok: false, description: 'Bad Gateway' }, 502));
    const client = new TelegramBotApiClient('token-123', fetch);

    await expect(client.deleteWebhook({ dropPendingUpdates: false }))
      .rejects.toBeInstanceOf(TelegramBotApiError);
  });
});
