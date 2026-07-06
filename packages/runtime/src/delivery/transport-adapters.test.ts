import { describe, expect, it, vi } from 'vitest';
import { SlackTransportAdapter, TelegramTransportAdapter } from './transport-adapters.js';

describe('transport adapters', () => {
  it('posts Telegram messages with native fetch and returns the platform id', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      result: { message_id: 12345 },
    }), { status: 200 }));
    const adapter = new TelegramTransportAdapter('token-123', fetch);

    await expect(adapter.send({
      body: 'hello',
      destination: { chatId: 'telegram-chat-42' },
      format: 'plain_text',
    })).resolves.toEqual({ platformMessageId: '12345' });

    expect(fetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bottoken-123/sendMessage',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ chat_id: 'telegram-chat-42', text: 'hello' }),
      }),
    );
  });

  it('can post Telegram messages to a configured Bot API base URL', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      result: { message_id: 'local-1' },
    }), { status: 200 }));
    const adapter = new TelegramTransportAdapter('token-123', fetch, {
      apiBaseUrl: 'http://127.0.0.1:9999',
    });

    await expect(adapter.send({
      body: 'hello',
      destination: { chatId: 'telegram-chat-42' },
      format: 'plain_text',
    })).resolves.toEqual({ platformMessageId: 'local-1' });

    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9999/bottoken-123/sendMessage',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sends Telegram mrkdwn as MarkdownV2 and falls back to plain text on format errors', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        description: 'Bad Request: cannot parse entities',
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { message_id: 222 },
      }), { status: 200 }));
    const adapter = new TelegramTransportAdapter('token-123', fetch);

    await expect(adapter.send({
      body: '**Summary**',
      destination: { chatId: 'telegram-chat-42' },
      format: 'mrkdwn',
    })).resolves.toEqual({ platformMessageId: '222' });

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
      chat_id: 'telegram-chat-42',
      parse_mode: 'MarkdownV2',
    });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1].body))).toEqual({
      chat_id: 'telegram-chat-42',
      text: '**Summary**',
    });
  });

  it('sends Telegram typing as sendChatAction', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));
    const adapter = new TelegramTransportAdapter('token-123', fetch);

    await expect(adapter.sendTyping?.({ destination: { chatId: 'telegram-chat-42' } })).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bottoken-123/sendChatAction',
      expect.objectContaining({
        body: JSON.stringify({ chat_id: 'telegram-chat-42', action: 'typing' }),
      }),
    );
  });

  it('sends then edits a Telegram status message', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 501 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 501 } }), { status: 200 }));
    const adapter = new TelegramTransportAdapter('token-123', fetch);

    await expect(adapter.sendOrUpdateStatus?.({
      body: 'Checking accounts...',
      destination: { chatId: 'telegram-chat-42' },
    })).resolves.toEqual({ platformMessageId: '501' });
    await expect(adapter.sendOrUpdateStatus?.({
      body: 'Preparing final answer...',
      destination: { chatId: 'telegram-chat-42' },
      statusMessageId: '501',
    })).resolves.toEqual({ platformMessageId: '501' });

    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      'https://api.telegram.org/bottoken-123/sendMessage',
      'https://api.telegram.org/bottoken-123/editMessageText',
    ]);
  });

  it('posts Slack messages with native fetch and returns the platform id', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      ts: '1700000000.000100',
    }), { status: 200 }));
    const adapter = new SlackTransportAdapter('xoxb-token', fetch);

    await expect(adapter.send({
      body: 'hello',
      destination: { channelId: 'C123' },
      format: 'mrkdwn',
    })).resolves.toEqual({ platformMessageId: '1700000000.000100' });

    expect(fetch).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer xoxb-token' }),
        body: JSON.stringify({ channel: 'C123', text: 'hello', mrkdwn: true }),
      }),
    );
  });
});
