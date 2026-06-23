import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { analystSandboxToolId } from '@plus-one/runtime';
import { createQueryRoleAgents, splitQueryRoleTools } from '../src/agents/query/index.js';

const models = {
  lead: { id: 'provider/lead', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
  maker: { id: 'provider/maker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
  checker: { id: 'provider/checker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
};

const tools = {
  'query.account_list': { execute: vi.fn() } as never,
  'query.current_balances': { execute: vi.fn() } as never,
  [analystSandboxToolId]: { execute: vi.fn() } as never,
};

describe('Query Mastra role agents', () => {
  it('splits Query tools by role instead of giving every Query agent every tool', () => {
    expect(Object.keys(splitQueryRoleTools(tools, 'lead'))).toEqual([]);
    expect(Object.keys(splitQueryRoleTools(tools, 'query-maker')).sort()).toEqual([
      'query.account_list',
      'query.current_balances',
    ]);
    expect(Object.keys(splitQueryRoleTools(tools, 'query-checker'))).toEqual([]);
    expect(Object.keys(splitQueryRoleTools(tools, 'analyst-maker'))).toEqual([analystSandboxToolId]);
    expect(Object.keys(splitQueryRoleTools(tools, 'analyst-checker'))).toEqual([analystSandboxToolId]);
  });

  it('creates one concrete Mastra agent per Query role with role-owned instructions', () => {
    const configs: Array<{
      id?: string;
      name?: string;
      description?: string;
      model?: unknown;
      tools?: Record<string, unknown>;
      instructions?: unknown;
    }> = [];
    const agents = createQueryRoleAgents({
      models,
      tools,
      agentFactory: (config) => {
        configs.push(config as typeof configs[number]);
        return { generate: vi.fn() } as unknown as Agent;
      },
    });

    expect(Object.keys(agents).sort()).toEqual([
      'analyst-checker',
      'analyst-maker',
      'query-checker',
      'query-lead',
      'query-maker',
    ]);
    expect(configs.map((config) => config.id).sort()).toEqual([
      'analyst-checker',
      'analyst-maker',
      'query-checker',
      'query-lead',
      'query-maker',
    ]);
    expect(configs.find((config) => config.id === 'query-lead')).toMatchObject({
      name: 'Query Team Lead',
      model: 'provider/lead',
      tools: {},
    });
    expect(String(configs.find((config) => config.id === 'query-lead')?.instructions))
      .toContain('select the correct Query work cell');
    expect(Object.keys(configs.find((config) => config.id === 'query-maker')?.tools ?? {}).sort())
      .toEqual(['query.account_list', 'query.current_balances']);
    expect(Object.keys(configs.find((config) => config.id === 'query-checker')?.tools ?? {}))
      .toEqual([]);
    expect(Object.keys(configs.find((config) => config.id === 'analyst-maker')?.tools ?? {}))
      .toEqual([analystSandboxToolId]);
    expect(Object.keys(configs.find((config) => config.id === 'analyst-checker')?.tools ?? {}))
      .toEqual([analystSandboxToolId]);
  });
});
