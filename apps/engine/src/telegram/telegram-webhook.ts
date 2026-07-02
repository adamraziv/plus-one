import { registerApiRoute } from '@mastra/core/server';
import type { TelegramMessageUpdate, TelegramUpdateProcessor } from './telegram-update-processor.js';

export function createTelegramWebhookRoute(input: {
  webhookSecret: string;
  processor: Pick<TelegramUpdateProcessor, 'handle'>;
}) {
  return registerApiRoute('/telegram/webhook', {
    method: 'POST',
    requiresAuth: false,
    handler: async (context) => {
      const secret = context.req.header('x-telegram-bot-api-secret-token');
      if (secret !== input.webhookSecret) {
        return context.json({ error: 'telegram_webhook_secret_invalid' }, 401);
      }

      const update = await context.req.json() as TelegramMessageUpdate;
      return context.json(await input.processor.handle(update));
    },
  });
}
