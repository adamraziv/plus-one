import { TelegramBotApiError } from './telegram-bot-api.js';
import type { TelegramMessageUpdate, TelegramUpdateProcessor } from './telegram-update-processor.js';

interface TelegramPollingApi {
  deleteWebhook(input: { dropPendingUpdates: boolean; signal: AbortSignal }): Promise<void>;
  getUpdates(input: {
    offset?: number;
    timeoutSeconds: number;
    allowedUpdates: string[];
    signal: AbortSignal;
  }): Promise<TelegramMessageUpdate[]>;
}

export class TelegramPollingReceiver {
  private offset: number | undefined;

  constructor(private readonly input: {
    api: TelegramPollingApi;
    processor: Pick<TelegramUpdateProcessor, 'handle'>;
    timeoutSeconds?: number;
    retryDelayMs?: number;
    maxConflictRetries?: number;
    maxNetworkRetries?: number;
    onReady?: () => void;
  }) {}

  async start(signal: AbortSignal): Promise<void> {
    await this.deleteWebhook(signal);
    if (signal.aborted) return;
    this.input.onReady?.();
    let conflictRetries = 0;
    let networkRetries = 0;
    while (!signal.aborted) {
      let updates: TelegramMessageUpdate[];
      try {
        updates = await this.input.api.getUpdates({
          ...(this.offset === undefined ? {} : { offset: this.offset }),
          timeoutSeconds: this.input.timeoutSeconds ?? 20,
          allowedUpdates: ['message'],
          signal,
        });
        conflictRetries = 0;
        networkRetries = 0;
      } catch (error) {
        if (isAbortError(error)) return;
        if (isInvalidBotTokenError(error)) {
          throw new Error('Telegram polling startup failed: invalid bot token.');
        }
        if (error instanceof TelegramBotApiError && error.code === 'telegram_polling_conflict') {
          conflictRetries += 1;
          if (conflictRetries > (this.input.maxConflictRetries ?? 3)) {
            throw new Error('Telegram polling conflict: another process is polling this bot token.');
          }
          await sleep(this.input.retryDelayMs ?? 1_000, signal);
          continue;
        }
        if (!isTransientPollingError(error)) throw error;
        networkRetries += 1;
        if (networkRetries > (this.input.maxNetworkRetries ?? 10)) {
          throw new Error('Telegram polling network error: could not reconnect after repeated transient failures.');
        }
        await sleep(this.input.retryDelayMs ?? 1_000, signal);
        continue;
      }
      for (const update of updates) {
        await this.input.processor.handle(update);
        this.offset = update.update_id + 1;
      }
    }
  }

  private async deleteWebhook(signal: AbortSignal): Promise<void> {
    let networkRetries = 0;
    while (!signal.aborted) {
      try {
        await this.input.api.deleteWebhook({ dropPendingUpdates: false, signal });
        return;
      } catch (error) {
        if (isAbortError(error)) return;
        if (isInvalidBotTokenError(error)) {
          throw new Error('Telegram polling startup failed: invalid bot token.');
        }
        if (!isTransientPollingError(error)) throw error;
        networkRetries += 1;
        if (networkRetries > (this.input.maxNetworkRetries ?? 10)) {
          throw new Error('Telegram polling startup failed: could not clear stale webhook after repeated transient failures.');
        }
        await sleep(this.input.retryDelayMs ?? 1_000, signal);
      }
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isInvalidBotTokenError(error: unknown): boolean {
  return error instanceof TelegramBotApiError
    && error.code === 'telegram_api_error'
    && (error.status === 401 || error.status === 403);
}

function isTransientPollingError(error: unknown): boolean {
  if (error instanceof TelegramBotApiError) {
    return error.code === 'telegram_api_error'
      && (error.status === undefined || error.status === 429 || error.status >= 500);
  }
  return error instanceof Error;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timeout);
      resolve();
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
