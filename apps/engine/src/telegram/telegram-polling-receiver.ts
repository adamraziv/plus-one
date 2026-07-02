import { TelegramBotApiError } from './telegram-bot-api.js';
import type { TelegramMessageUpdate, TelegramUpdateProcessor } from './telegram-update-processor.js';

interface TelegramPollingApi {
  deleteWebhook(input: { dropPendingUpdates: boolean }): Promise<void>;
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
  }) {}

  async start(signal: AbortSignal): Promise<void> {
    await this.input.api.deleteWebhook({ dropPendingUpdates: false });
    let conflictRetries = 0;
    while (!signal.aborted) {
      try {
        const updates = await this.input.api.getUpdates({
          ...(this.offset === undefined ? {} : { offset: this.offset }),
          timeoutSeconds: this.input.timeoutSeconds ?? 20,
          allowedUpdates: ['message'],
          signal,
        });
        for (const update of updates) {
          await this.input.processor.handle(update);
          this.offset = update.update_id + 1;
        }
        conflictRetries = 0;
      } catch (error) {
        if (isAbortError(error)) return;
        if (error instanceof TelegramBotApiError && error.code === 'telegram_polling_conflict') {
          conflictRetries += 1;
          if (conflictRetries > (this.input.maxConflictRetries ?? 3)) {
            throw new Error('Telegram polling conflict: another process is polling this bot token.');
          }
          await sleep(this.input.retryDelayMs ?? 1_000, signal);
          continue;
        }
        if (!(error instanceof TelegramBotApiError)) throw error;
        await sleep(this.input.retryDelayMs ?? 1_000, signal);
      }
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}
