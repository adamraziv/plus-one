import { Mastra } from '@mastra/core';
import { describe, expect, it, vi } from 'vitest';
import { bootstrap } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { createMastra } from '../src/mastra.js';

const environment = {
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
};

describe('engine scaffold', () => {
  it('loads engine, database, and model configuration together', () => {
    const config = loadConfig({
      ...environment,
      LLM_ENDPOINT: 'https://llm.example.test/v1',
      LLM_API_KEY: 'test-api-key',
      ORCHESTRATOR_MODEL: 'openai/gpt-5',
      LEAD_MODEL: 'openai/gpt-5',
      MAKER_MODEL: 'openai/gpt-5-mini',
      CHECKER_MODEL: 'openai/gpt-5',
      RESEARCH_MODEL: 'openai/gpt-5',
    });
    expect(config).toMatchObject({ nodeEnv: 'test', host: '127.0.0.1', port: 4111 });
    expect(config.database.poolUrls.operations).toContain('operations');
    expect(config.models).toEqual({
      orchestrator: { id: 'openai/gpt-5', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      lead: { id: 'openai/gpt-5', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      maker: { id: 'openai/gpt-5-mini', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      checker: { id: 'openai/gpt-5', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      research: { id: 'openai/gpt-5', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
    });
  });

  it('constructs Mastra with a configured memory storage URL', () => {
    const mastra = createMastra(environment.DATABASE_MEMORY_URL);
    const storage = mastra.getStorage();

    expect(mastra).toBeInstanceOf(Mastra);
    expect(storage?.stores?.memory).toBeDefined();
  });

  it('passes the memory URL to the Mastra factory and closes pools through the runtime handle', async () => {
    const pools = {} as never;
    const close = vi.fn(async () => undefined);
    const validateModels = vi.fn(async () => undefined);
    const mastra = createMastra(environment.DATABASE_MEMORY_URL);
    const agentSystem = { teams: [], mastraAgents: { orchestrator: {} } };
    const createMastraInstance = vi.fn((memoryConnectionString?: string, agents?: unknown, apiRoutes?: unknown[]) => {
      expect(memoryConnectionString).toBe(environment.DATABASE_MEMORY_URL);
      expect(agents).toBe(agentSystem.mastraAgents);
      expect(Array.isArray(apiRoutes)).toBe(true);
      return mastra;
    });
    const runtime = await bootstrap({
      environment,
      createPools: () => pools,
      verifyPools: vi.fn(async () => undefined),
      closePools: close,
      validateModels,
      createMastraInstance,
      createAgentSystemInstance: vi.fn(() => agentSystem as never),
    });
    expect(runtime.agentSystem).toBe(agentSystem);
    expect(createMastraInstance).toHaveBeenCalledTimes(1);
    await runtime.close();
    expect(close).toHaveBeenCalledWith(pools);
  });

  it('passes configured Query tools into the agent system', async () => {
    const queryTools = { 'query.account_list': {} };
    const createAgentSystemInstance = vi.fn(() => ({ teams: [], mastraAgents: {} }) as never);

    await bootstrap({
      environment,
      validateModels: vi.fn(async () => undefined),
      createPools: () => ({} as never),
      verifyPools: vi.fn(async () => undefined),
      createMastraInstance: vi.fn(() => createMastra(environment.DATABASE_MEMORY_URL)),
      createAgentSystemInstance,
      queryTools,
    });

    expect(createAgentSystemInstance).toHaveBeenCalledWith(expect.objectContaining({ queryTools }));
  });

  it('passes a configured orchestrator agent into the agent system', async () => {
    const orchestratorAgent = { generate: vi.fn() };
    const createAgentSystemInstance = vi.fn(() => ({ teams: [], mastraAgents: { orchestrator: orchestratorAgent } }) as never);

    await bootstrap({
      environment,
      validateModels: vi.fn(async () => undefined),
      createPools: () => ({} as never),
      verifyPools: vi.fn(async () => undefined),
      createMastraInstance: vi.fn(() => createMastra(environment.DATABASE_MEMORY_URL)),
      createAgentSystemInstance,
      orchestratorAgent: orchestratorAgent as never,
    });

    expect(createAgentSystemInstance).toHaveBeenCalledWith(expect.objectContaining({ orchestratorAgent }));
  });

  it('does not production-bootstrap without Query tools and an orchestrator agent', async () => {
    const production = { ...environment, NODE_ENV: 'production', LLM_API_KEY: 'test-api-key' };

    await expect(bootstrap({
      environment: production,
      validateModels: vi.fn(async () => undefined),
      createPools: () => ({} as never),
    })).rejects.toThrow('Production bootstrap requires configured Query tools.');

    await expect(bootstrap({
      environment: production,
      validateModels: vi.fn(async () => undefined),
      createPools: () => ({} as never),
      queryTools: { 'query.account_list': {} },
    })).rejects.toThrow('Production bootstrap requires a configured orchestrator agent.');
  });

  it('validates configured models before creating database pools', async () => {
    const callOrder: string[] = [];
    const validateModels = vi.fn(async () => {
      callOrder.push('validate');
    });
    const createPools = vi.fn(() => {
      callOrder.push('pools');
      return {} as never;
    });

    await bootstrap({
      environment,
      validateModels,
      createPools,
      verifyPools: vi.fn(async () => undefined),
      createMastraInstance: vi.fn(() => ({}) as never),
      createAgentSystemInstance: vi.fn(() => ({ teams: [], mastraAgents: {} }) as never),
    });

    expect(callOrder.slice(0, 2)).toEqual(['validate', 'pools']);
  });
});
