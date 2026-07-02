import { describe, expect, it, vi } from 'vitest';
import { TelegramBotApiError } from '../src/telegram/telegram-bot-api.js';
import { TelegramPollingReceiver } from '../src/telegram/telegram-polling-receiver.js';

function update(id: number) {
  return { update_id: id, message: { message_id: id, date: 1782864000, chat: { id, type: 'private' } } };
}

describe('TelegramPollingReceiver', () => {
  it('deletes stale webhook before polling and delegates updates', async () => {
    const abort = new AbortController();
    const api = {
      deleteWebhook: vi.fn(async () => undefined),
      getUpdates: vi.fn()
        .mockResolvedValueOnce([update(7), update(8)])
        .mockImplementationOnce(async () => {
          abort.abort();
          return [];
        }),
    };
    const processor = { handle: vi.fn(async () => ({ status: 'ignored', reason: 'unsupported_update' })) };
    const receiver = new TelegramPollingReceiver({
      api,
      processor,
      timeoutSeconds: 1,
      retryDelayMs: 1,
    });

    await receiver.start(abort.signal);

    expect(api.deleteWebhook).toHaveBeenCalledWith({ dropPendingUpdates: false });
    expect(processor.handle).toHaveBeenNthCalledWith(1, update(7));
    expect(processor.handle).toHaveBeenNthCalledWith(2, update(8));
    expect(api.getUpdates).toHaveBeenNthCalledWith(2, {
      offset: 9,
      timeoutSeconds: 1,
      allowedUpdates: ['message'],
      signal: abort.signal,
    });
  });

  it('does not advance offset when processing throws', async () => {
    const abort = new AbortController();
    const api = {
      deleteWebhook: vi.fn(async () => undefined),
      getUpdates: vi.fn(async () => {
        abort.abort();
        return [update(11)];
      }),
    };
    const receiver = new TelegramPollingReceiver({
      api,
      processor: { handle: vi.fn(async () => { throw new Error('processor failed'); }) },
      timeoutSeconds: 1,
      retryDelayMs: 1,
    });

    await expect(receiver.start(abort.signal)).rejects.toThrow('processor failed');
  });

  it('retries temporary 409 polling conflicts before continuing', async () => {
    const abort = new AbortController();
    const api = {
      deleteWebhook: vi.fn(async () => undefined),
      getUpdates: vi.fn()
        .mockRejectedValueOnce(new TelegramBotApiError({
          code: 'telegram_polling_conflict',
          status: 409,
          description: 'Conflict: terminated by other getUpdates request',
        }))
        .mockImplementationOnce(async () => {
          abort.abort();
          return [];
        }),
    };
    const receiver = new TelegramPollingReceiver({
      api,
      processor: { handle: vi.fn() },
      timeoutSeconds: 1,
      retryDelayMs: 1,
      maxConflictRetries: 2,
    });

    await expect(receiver.start(abort.signal)).resolves.toBeUndefined();
    expect(api.getUpdates).toHaveBeenCalledTimes(2);
  });

  it('surfaces repeated 409 polling conflicts as fatal operator errors', async () => {
    const api = {
      deleteWebhook: vi.fn(async () => undefined),
      getUpdates: vi.fn(async () => {
        throw new TelegramBotApiError({
          code: 'telegram_polling_conflict',
          status: 409,
          description: 'Conflict: terminated by other getUpdates request',
        });
      }),
    };
    const receiver = new TelegramPollingReceiver({
      api,
      processor: { handle: vi.fn() },
      timeoutSeconds: 1,
      retryDelayMs: 1,
      maxConflictRetries: 1,
    });

    await expect(receiver.start(new AbortController().signal)).rejects.toThrow(
      'Telegram polling conflict: another process is polling this bot token.',
    );
  });

  it('retries transient API failures until aborted', async () => {
    const abort = new AbortController();
    const api = {
      deleteWebhook: vi.fn(async () => undefined),
      getUpdates: vi.fn()
        .mockRejectedValueOnce(new TelegramBotApiError({ code: 'telegram_api_error', status: 502, description: 'Bad Gateway' }))
        .mockImplementationOnce(async () => {
          abort.abort();
          return [];
        }),
    };
    const receiver = new TelegramPollingReceiver({
      api,
      processor: { handle: vi.fn() },
      timeoutSeconds: 1,
      retryDelayMs: 1,
    });

    await expect(receiver.start(abort.signal)).resolves.toBeUndefined();
    expect(api.getUpdates).toHaveBeenCalledTimes(2);
  });
});
