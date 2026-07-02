import type { TelegramMessageUpdate } from './telegram-update-processor.js';

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export class TelegramBotApiError extends Error {
  constructor(readonly input: {
    code: 'telegram_api_error' | 'telegram_polling_conflict';
    status?: number;
    description?: string;
  }) {
    super(input.description ?? input.code);
    this.name = 'TelegramBotApiError';
  }

  get code() {
    return this.input.code;
  }

  get status() {
    return this.input.status;
  }

  get description() {
    return this.input.description;
  }
}

export class TelegramBotApiClient {
  constructor(
    private readonly token: string,
    private readonly fetchFn: Fetch = fetch,
    private readonly options: { apiBaseUrl?: string } = {},
  ) {}

  async deleteWebhook(input: { dropPendingUpdates: boolean }): Promise<void> {
    await this.request('deleteWebhook', {
      drop_pending_updates: input.dropPendingUpdates,
    });
  }

  async setWebhook(input: {
    url: string;
    secretToken: string;
    allowedUpdates: string[];
    dropPendingUpdates: boolean;
  }): Promise<void> {
    await this.request('setWebhook', {
      url: input.url,
      secret_token: input.secretToken,
      allowed_updates: input.allowedUpdates,
      drop_pending_updates: input.dropPendingUpdates,
    });
  }

  async getUpdates(input: {
    offset?: number;
    timeoutSeconds: number;
    allowedUpdates: string[];
    signal?: AbortSignal;
  }): Promise<TelegramMessageUpdate[]> {
    const payload = await this.request('getUpdates', {
      ...(input.offset === undefined ? {} : { offset: input.offset }),
      timeout: input.timeoutSeconds,
      allowed_updates: input.allowedUpdates,
    }, input.signal);
    return payload.result as TelegramMessageUpdate[];
  }

  private async request(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ result?: unknown }> {
    const apiBaseUrl = this.options.apiBaseUrl ?? 'https://api.telegram.org';
    const response = await this.fetchFn(`${apiBaseUrl}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
    const payload = await response.json() as { ok?: boolean; result?: unknown; description?: string };
    if (!response.ok || payload.ok !== true) {
      throw new TelegramBotApiError({
        code: response.status === 409 ? 'telegram_polling_conflict' : 'telegram_api_error',
        status: response.status,
        description: payload.description,
      });
    }
    return payload;
  }
}
