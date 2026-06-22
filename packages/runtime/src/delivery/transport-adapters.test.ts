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
