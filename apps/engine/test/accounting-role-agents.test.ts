import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { createAccountingRoleAgents } from '../src/agents/accounting/index.js';

const models = {
  lead: { id: 'provider/lead', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
  maker: { id: 'provider/maker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
  checker: { id: 'provider/checker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
};

const expectedIds = [
  'accounting-lead',
  'chart-checker',
  'chart-maker',
  'ingestion-checker',
  'ingestion-maker',
  'journal-checker',
  'journal-maker',
  'reconciliation-checker',
  'reconciliation-maker',
  'transaction-capture-checker',
  'transaction-capture-maker',
] as const;

describe('Accounting Mastra role agents', () => {
  it('creates one concrete Mastra agent per Accounting Team role with role-owned instructions', () => {
    const configs: Array<{
      id?: string;
      name?: string;
      description?: string;
      model?: unknown;
      tools?: Record<string, unknown>;
      instructions?: unknown;
    }> = [];
    const agents = createAccountingRoleAgents({
      models,
      tools: {},
      agentFactory: (config) => {
        configs.push(config as typeof configs[number]);
        return { generate: vi.fn() } as unknown as Agent;
      },
    });

    expect(Object.keys(agents).sort()).toEqual([...expectedIds]);
    expect(configs.map((config) => config.id).sort()).toEqual([...expectedIds]);
    expect(configs.every((config) => Object.keys(config.tools ?? {}).length === 0)).toBe(true);
    expect(configs.find((config) => config.id === 'accounting-lead')).toMatchObject({
      name: 'Accounting Team Lead',
      model: { id: 'provider/lead', url: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      tools: {},
    });
    expect(configs.find((config) => config.id === 'journal-maker')).toMatchObject({
      model: { id: 'provider/maker', url: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      tools: {},
    });
    expect(configs.find((config) => config.id === 'journal-checker')).toMatchObject({
      model: { id: 'provider/checker', url: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      tools: {},
    });
  });

  it('keeps ingestion and reconciliation inside the Accounting Team agent folder', () => {
    const agents = createAccountingRoleAgents({
      models,
      tools: {},
      agentFactory: () => ({ generate: vi.fn() } as unknown as Agent),
    });

    expect(agents['ingestion-maker']).toBeDefined();
    expect(agents['ingestion-checker']).toBeDefined();
    expect(agents['reconciliation-maker']).toBeDefined();
    expect(agents['reconciliation-checker']).toBeDefined();
  });

  it('puts input/output contracts and no-direct-tool boundaries in every instruction set', () => {
    const configs: Array<{ id?: string; instructions?: unknown }> = [];
    createAccountingRoleAgents({
      models,
      tools: {},
      agentFactory: (config) => {
        configs.push(config as typeof configs[number]);
        return { generate: vi.fn() } as unknown as Agent;
      },
    });

    for (const config of configs) {
      const instructions = String(config.instructions);
      expect(instructions).toContain('Input contract:');
      expect(instructions).toContain('Output contract:');
      expect(instructions).toContain('Do not access databases, SQL, command handlers, command registries, provider accounts, external financial systems, arbitrary files, or unavailable tools.');
      expect(instructions).toContain('Return only');
    }
    expect(String(configs.find((config) => config.id === 'accounting-lead')?.instructions))
      .toContain('transaction_capture -> transaction-capture');
    expect(String(configs.find((config) => config.id === 'transaction-capture-maker')?.instructions))
      .toContain('accounting-clarification');
    expect(String(configs.find((config) => config.id === 'ingestion-maker')?.instructions))
      .toContain('Never auto-post probable duplicates');
    expect(String(configs.find((config) => config.id === 'chart-checker')?.instructions))
      .toContain('requires external confirmation before persistence');
    expect(String(configs.find((config) => config.id === 'reconciliation-checker')?.instructions))
      .toContain('Return insufficient_evidence when checked evidence is missing');
  });
});
