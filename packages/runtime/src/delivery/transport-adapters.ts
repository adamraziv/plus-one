import { PlusOneError } from '@plus-one/contracts';
import type { TransportAdapter, TransportSendInput } from './final-delivery-handler.js';

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export class TelegramTransportAdapter implements TransportAdapter {
  constructor(
    private readonly token: string,
    private readonly fetchFn: Fetch = fetch,
    private readonly options: { apiBaseUrl?: string } = {},
  ) {}

  async send(input: TransportSendInput): Promise<{ platformMessageId: string }> {
    const chatId = input.destination.chatId;
    if (typeof chatId !== 'string') throw this.error('telegram_chat_id_missing');
    const apiBaseUrl = this.options.apiBaseUrl ?? 'https://api.telegram.org';
    const response = await this.fetchFn(`${apiBaseUrl}/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: input.body }),
    });
    const payload = await response.json() as { ok?: boolean; result?: { message_id?: number | string } };
    if (!response.ok || payload.ok !== true || payload.result?.message_id === undefined) {
      throw this.error('telegram_send_failed');
    }
    return { platformMessageId: String(payload.result.message_id) };
  }

  private error(code: string): PlusOneError {
    return new PlusOneError({ category: 'runtime_failure', code,
      message: 'Telegram delivery failed', retry: 'after_backoff',
      receiptLookupRequired: false, details: {} });
  }
}

export class SlackTransportAdapter implements TransportAdapter {
  constructor(
    private readonly token: string,
    private readonly fetchFn: Fetch = fetch,
  ) {}

  async send(input: TransportSendInput): Promise<{ platformMessageId: string }> {
    const channelId = input.destination.channelId;
    if (typeof channelId !== 'string') throw this.error('slack_channel_id_missing');
    const response = await this.fetchFn('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        channel: channelId,
        text: input.body,
        mrkdwn: input.format === 'mrkdwn',
      }),
    });
    const payload = await response.json() as { ok?: boolean; ts?: string };
    if (!response.ok || payload.ok !== true || payload.ts === undefined) {
      throw this.error('slack_send_failed');
    }
    return { platformMessageId: payload.ts };
  }

  private error(code: string): PlusOneError {
    return new PlusOneError({ category: 'runtime_failure', code,
      message: 'Slack delivery failed', retry: 'after_backoff',
      receiptLookupRequired: false, details: {} });
  }
}
