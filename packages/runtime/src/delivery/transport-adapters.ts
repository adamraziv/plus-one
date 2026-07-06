import { PlusOneError } from '@plus-one/contracts';
import { classifyTelegramApiFailure, TransportSendError } from '../gateway/send-result.js';
import type { TransportAdapter, TransportSendInput } from './final-delivery-handler.js';
import { toTelegramMarkdownV2 } from './telegram-markdown.js';

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export class TelegramTransportAdapter implements TransportAdapter {
  constructor(
    private readonly token: string,
    private readonly fetchFn: Fetch = fetch,
    private readonly options: { apiBaseUrl?: string } = {},
  ) {}

  async send(input: TransportSendInput): Promise<{ platformMessageId: string }> {
    const chatId = this.chatId(input.destination);
    if (input.format === 'mrkdwn') {
      try {
        return await this.sendMessage({
          chatId,
          text: toTelegramMarkdownV2(input.body),
          parseMode: 'MarkdownV2',
        });
      } catch (error) {
        if (!(error instanceof TransportSendError) || error.failure.category !== 'bad_format') throw error;
        return this.sendMessage({ chatId, text: input.body });
      }
    }
    return this.sendMessage({ chatId, text: input.body });
  }

  private chatId(destination: Record<string, unknown>): string {
    const chatId = destination.chatId;
    if (typeof chatId !== 'string') {
      throw new TransportSendError({
        category: 'unknown',
        message: 'Telegram chat id is missing.',
        retryable: false,
        receiptLookupRequired: false,
      });
    }
    return chatId;
  }

  private async sendMessage(input: {
    chatId: string;
    text: string;
    parseMode?: 'MarkdownV2';
    replyToMessageId?: string;
  }): Promise<{ platformMessageId: string }> {
    const payload = await this.request('sendMessage', {
      chat_id: input.chatId,
      text: input.text,
      ...(input.parseMode === undefined ? {} : { parse_mode: input.parseMode }),
      ...(input.replyToMessageId === undefined ? {} : { reply_to_message_id: input.replyToMessageId }),
    });
    const messageId = payload.result?.message_id;
    if (messageId === undefined) {
      throw new TransportSendError({
        category: 'unknown',
        message: 'Telegram sendMessage response did not include message_id.',
        retryable: false,
        receiptLookupRequired: false,
      });
    }
    return { platformMessageId: String(messageId) };
  }

  private async request(
    method: string,
    body: Record<string, unknown>,
  ): Promise<{ result?: { message_id?: number | string } }> {
    const apiBaseUrl = this.options.apiBaseUrl ?? 'https://api.telegram.org';
    const response = await this.fetchFn(`${apiBaseUrl}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as {
      ok?: boolean;
      result?: { message_id?: number | string };
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!response.ok || payload.ok !== true) {
      throw new TransportSendError(classifyTelegramApiFailure({
        status: response.status,
        description: payload.description,
        retryAfterSeconds: payload.parameters?.retry_after,
      }));
    }
    return payload;
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
