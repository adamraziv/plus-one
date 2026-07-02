import { describe, expect, it, vi } from 'vitest';
import {
  formatTelegramReadiness,
  LiveCliTelegramActions,
} from '../src/live-cli/telegram-actions.js';

describe('live CLI Telegram actions', () => {
  it('reports polling readiness when only the bot token is configured', () => {
    expect(formatTelegramReadiness({
      TELEGRAM_BOT_TOKEN: 'token-secret',
    })).toEqual([
      'TELEGRAM_BOT_TOKEN: configured',
      'Telegram receiver: polling',
      'TELEGRAM_WEBHOOK_SECRET: unused',
      'TELEGRAM_WEBHOOK_URL: missing',
      'TELEGRAM_API_BASE_URL: default',
    ].join('\n'));

    expect(formatTelegramReadiness({
      TELEGRAM_BOT_TOKEN: 'token-secret',
    })).not.toContain('token-secret');
  });

  it('reports webhook readiness without revealing secret values', () => {
    expect(formatTelegramReadiness({
      TELEGRAM_BOT_TOKEN: 'token-secret',
      TELEGRAM_WEBHOOK_URL: 'https://plus-one.example.test/telegram/webhook',
      TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
      TELEGRAM_API_BASE_URL: 'https://telegram.example.test',
    })).toEqual([
      'TELEGRAM_BOT_TOKEN: configured',
      'Telegram receiver: webhook',
      'TELEGRAM_WEBHOOK_SECRET: configured',
      'TELEGRAM_WEBHOOK_URL: configured',
      'TELEGRAM_API_BASE_URL: custom',
    ].join('\n'));

    expect(formatTelegramReadiness({
      TELEGRAM_BOT_TOKEN: 'token-secret',
      TELEGRAM_WEBHOOK_URL: 'https://plus-one.example.test/telegram/webhook',
      TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
    })).not.toContain('webhook-secret');
  });

  it('reports missing Telegram configuration as disabled status text', () => {
    expect(formatTelegramReadiness({})).toEqual([
      'TELEGRAM_BOT_TOKEN: missing',
      'Telegram receiver: disabled',
      'TELEGRAM_WEBHOOK_SECRET: unused',
      'TELEGRAM_WEBHOOK_URL: missing',
      'TELEGRAM_API_BASE_URL: default',
    ].join('\n'));
  });

  it('reports invalid webhook readiness when URL is configured without a secret', () => {
    expect(formatTelegramReadiness({
      TELEGRAM_BOT_TOKEN: 'token-secret',
      TELEGRAM_WEBHOOK_URL: 'https://plus-one.example.test/telegram/webhook',
    })).toEqual([
      'TELEGRAM_BOT_TOKEN: configured',
      'Telegram receiver: invalid',
      'TELEGRAM_WEBHOOK_SECRET: missing',
      'TELEGRAM_WEBHOOK_URL: configured',
      'TELEGRAM_API_BASE_URL: default',
    ].join('\n'));
  });

  it('delegates list, approve, and revoke to the existing pairing command handler', async () => {
    const service = {
      approveCode: vi.fn(async () => ({
        status: 'approved' as const,
        principal: {
          id: 'principal-1',
          channel: 'telegram' as const,
          externalUserId: '1234567890123',
          externalChatId: '9876543210987',
          householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
          approvedAt: '2026-07-02T00:00:00.000Z',
          approvedBy: 'cli:test',
          metadata: {},
        },
      })),
      revoke: vi.fn(async () => undefined),
      listPending: vi.fn(async () => []),
    };
    const actions = new LiveCliTelegramActions({
      service,
      approvedBy: 'cli:test',
      environment: {},
    });

    await expect(actions.listPending()).resolves.toBe('No pending Telegram pairing requests.');
    await expect(actions.approve('ABCDEFGH', 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K')).resolves.toBe(
      'Approved Telegram user 1234567890123 for household hh_01JNZQ4A9B8C7D6E5F4G3H2J1K.',
    );
    await expect(actions.revoke('1234567890123')).resolves.toBe('Revoked Telegram user 1234567890123.');
  });
});
