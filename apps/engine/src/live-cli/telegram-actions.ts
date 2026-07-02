import type { TelegramPairingService } from '@plus-one/runtime';
import { handleTelegramPairingCommand } from '../telegram/pairing-cli.js';

type PairingService = Pick<TelegramPairingService, 'approveCode' | 'revoke' | 'listPending'>;

export function formatTelegramReadiness(environment: Record<string, string | undefined>): string {
  const hasToken = environment.TELEGRAM_BOT_TOKEN !== undefined;
  const hasWebhookUrl = environment.TELEGRAM_WEBHOOK_URL !== undefined;
  const hasWebhookSecret = environment.TELEGRAM_WEBHOOK_SECRET !== undefined;
  const receiver = !hasToken
    ? 'disabled'
    : hasWebhookUrl && !hasWebhookSecret
      ? 'invalid'
      : hasWebhookUrl
        ? 'webhook'
        : 'polling';

  return [
    `TELEGRAM_BOT_TOKEN: ${hasToken ? 'configured' : 'missing'}`,
    `Telegram receiver: ${receiver}`,
    `TELEGRAM_WEBHOOK_SECRET: ${hasWebhookUrl ? (hasWebhookSecret ? 'configured' : 'missing') : 'unused'}`,
    `TELEGRAM_WEBHOOK_URL: ${hasWebhookUrl ? 'configured' : 'missing'}`,
    `TELEGRAM_API_BASE_URL: ${environment.TELEGRAM_API_BASE_URL === undefined ? 'default' : 'custom'}`,
  ].join('\n');
}

export class LiveCliTelegramActions {
  private readonly service: PairingService;
  private readonly approvedBy: string;
  private readonly environment: Record<string, string | undefined>;

  constructor(input: {
    service: PairingService;
    approvedBy: string;
    environment: Record<string, string | undefined>;
  }) {
    this.service = input.service;
    this.approvedBy = input.approvedBy;
    this.environment = input.environment;
  }

  status(): string {
    return formatTelegramReadiness(this.environment);
  }

  async listPending(): Promise<string> {
    return handleTelegramPairingCommand({
      argv: ['list-pending'],
      service: this.service,
      approvedBy: this.approvedBy,
    });
  }

  async approve(code: string, householdId: string): Promise<string> {
    return handleTelegramPairingCommand({
      argv: ['approve', code, '--household', householdId],
      service: this.service,
      approvedBy: this.approvedBy,
    });
  }

  async revoke(telegramUserId: string): Promise<string> {
    return handleTelegramPairingCommand({
      argv: ['revoke', telegramUserId],
      service: this.service,
      approvedBy: this.approvedBy,
    });
  }
}
