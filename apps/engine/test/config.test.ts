import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const baseEnvironment = {
  NODE_ENV: 'test',
  ENGINE_HOST: '127.0.0.1',
  ENGINE_PORT: '4111',
  DATABASE_MIGRATOR_URL: 'postgresql://migrator:password@127.0.0.1:5432/plus_one',
  DATABASE_ACCOUNTING_URL: 'postgresql://accounting:password@127.0.0.1:5432/plus_one',
  DATABASE_PLANNING_URL: 'postgresql://planning:password@127.0.0.1:5432/plus_one',
  DATABASE_OPERATIONS_URL: 'postgresql://operations:password@127.0.0.1:5432/plus_one',
  DATABASE_QUERY_URL: 'postgresql://query:password@127.0.0.1:5432/plus_one',
  DATABASE_MEMORY_URL: 'postgresql://memory:password@127.0.0.1:5432/plus_one',
  PLUS_ONE_ACCOUNTING_PASSWORD: 'accounting-password',
  PLUS_ONE_PLANNING_PASSWORD: 'planning-password',
  PLUS_ONE_OPERATIONS_PASSWORD: 'operations-password',
  PLUS_ONE_QUERY_PASSWORD: 'query-password-123',
  PLUS_ONE_MEMORY_PASSWORD: 'memory-password-123',
  LLM_ENDPOINT: 'https://llm.example.test/v1',
  LLM_API_KEY: 'test-api-key',
  ORCHESTRATOR_MODEL: 'openai/gpt-5',
  LEAD_MODEL: 'openai/gpt-5',
  MAKER_MODEL: 'openai/gpt-5-mini',
  CHECKER_MODEL: 'openai/gpt-5',
  RESEARCH_MODEL: 'openai/gpt-5',
} satisfies Record<string, string>;

describe('engine config', () => {
  it('uses a configurable end-to-end orchestrator turn deadline', () => {
    expect(loadConfig({ ...baseEnvironment, ORCHESTRATOR_TURN_TIMEOUT_MS: '45000' }).turnDeadlineMs).toBe(45_000);
    expect(loadConfig(baseEnvironment).turnDeadlineMs).toBe(60_000);
  });

  it('rejects raw model ids without provider prefix', () => {
    expect(() => loadConfig({
      ...baseEnvironment,
      ORCHESTRATOR_MODEL: 'deepseek-v4-flash',
    })).toThrow(/provider\/model/);
  });

  it('resolves Telegram polling mode when only the bot token is configured', () => {
    expect(loadConfig({
      ...baseEnvironment,
      TELEGRAM_BOT_TOKEN: 'telegram-token',
    }).telegram).toEqual({
      botToken: 'telegram-token',
      receiver: { mode: 'polling' },
    });
  });

  it('resolves Telegram webhook mode when webhook URL and secret are configured', () => {
    expect(loadConfig({
      ...baseEnvironment,
      TELEGRAM_BOT_TOKEN: 'telegram-token',
      TELEGRAM_WEBHOOK_URL: 'https://plus-one.example.test/telegram/webhook',
      TELEGRAM_WEBHOOK_SECRET: 'telegram-secret',
      TELEGRAM_API_BASE_URL: 'http://127.0.0.1:9999',
    }).telegram).toEqual({
      botToken: 'telegram-token',
      apiBaseUrl: 'http://127.0.0.1:9999',
      receiver: {
        mode: 'webhook',
        webhookUrl: 'https://plus-one.example.test/telegram/webhook',
        webhookSecret: 'telegram-secret',
      },
    });
  });

  it('rejects webhook URL without a Telegram bot token', () => {
    expect(() => loadConfig({
      ...baseEnvironment,
      TELEGRAM_WEBHOOK_URL: 'https://plus-one.example.test/telegram/webhook',
      TELEGRAM_WEBHOOK_SECRET: 'telegram-secret',
    })).toThrow(/TELEGRAM_BOT_TOKEN is required when TELEGRAM_WEBHOOK_URL is configured/);
  });

  it('rejects webhook URL without a Telegram webhook secret', () => {
    expect(() => loadConfig({
      ...baseEnvironment,
      TELEGRAM_BOT_TOKEN: 'telegram-token',
      TELEGRAM_WEBHOOK_URL: 'https://plus-one.example.test/telegram/webhook',
    })).toThrow(/TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_WEBHOOK_URL is configured/);
  });

  it('rejects Telegram webhook secrets that Telegram will not accept', () => {
    expect(() => loadConfig({
      ...baseEnvironment,
      TELEGRAM_BOT_TOKEN: 'telegram-token',
      TELEGRAM_WEBHOOK_URL: 'https://plus-one.example.test/telegram/webhook',
      TELEGRAM_WEBHOOK_SECRET: 'bad secret!',
    })).toThrow(/TELEGRAM_WEBHOOK_SECRET must be 1-256 characters using only A-Z, a-z, 0-9, underscore, or hyphen/);
  });
});
