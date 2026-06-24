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
  it('rejects raw model ids without provider prefix', () => {
    expect(() => loadConfig({
      ...baseEnvironment,
      ORCHESTRATOR_MODEL: 'deepseek-v4-flash',
    })).toThrow(/provider\/model/);
  });
});
