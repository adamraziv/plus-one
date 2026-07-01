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
    expect(storage?.stores?.workflows).toBeDefined();
    expect(mastra.getWorkflow('orchestrator-loop')).toBeDefined();
  });

  it('passes the memory URL to the Mastra factory and closes runtime storage before closing pools', async () => {
    const pools = {} as never;
    const lifecycle: string[] = [];
    const close = vi.fn(async () => undefined);
    const shutdown = vi.fn(async () => {
      lifecycle.push('shutdown');
    });
    const validateModels = vi.fn(async () => undefined);
    const mastra = createMastra(environment.DATABASE_MEMORY_URL);
    vi.spyOn(mastra, 'shutdown').mockImplementation(shutdown);
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
    close.mockImplementation(async () => {
      lifecycle.push('close');
    });
    await runtime.close();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(lifecycle).toEqual(['shutdown', 'close']);
    expect(close).toHaveBeenCalledWith(pools);
  });

  it('wires the /new command handler into runtime routes', async () => {
    const lifecycle: string[] = [];
    const shutdown = vi.fn(async () => {
      lifecycle.push('shutdown');
    });
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('INSERT INTO operations.channel_conversations')) {
          return {
            rows: [{
              conversation_id: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J2K',
              household_id: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
              channel: 'telegram',
              channel_type: 'direct',
              external_conversation_id: 'telegram-chat-42',
              external_thread_id: '',
              destination: { chatId: 'telegram-chat-42' },
              created_at: new Date('2026-06-30T00:01:00.000Z'),
              updated_at: new Date('2026-06-30T00:01:00.000Z'),
            }],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const operationsPool = { connect: vi.fn(async () => client) };
    const pools = { operations: operationsPool } as never;
    let apiRoutes: Array<{ path: string; handler(context: unknown): Promise<unknown> }> = [];
    const mastra = createMastra(environment.DATABASE_MEMORY_URL);
    vi.spyOn(mastra, 'shutdown').mockImplementation(shutdown);
    const createMastraInstance = vi.fn((memoryConnectionString?: string, agents?: unknown, routes?: unknown[]) => {
      apiRoutes = routes as typeof apiRoutes;
      return mastra;
    });

    await bootstrap({
      environment,
      createPools: () => pools,
      verifyPools: vi.fn(async () => undefined),
      closePools: vi.fn(async () => undefined),
      validateModels: vi.fn(async () => undefined),
      createMastraInstance,
      createAgentSystemInstance: vi.fn(() => ({ teams: [], mastraAgents: {} }) as never),
    });

    const inboundRoute = apiRoutes.find((route) => route.path === '/plus-one/inbound');
    expect(inboundRoute).toBeDefined();
    const json = vi.fn((body: unknown, status?: number) => ({ body, status }));
    await expect(inboundRoute?.handler({
      req: {
        json: vi.fn(async () => ({
          schemaName: 'inbound-channel-message',
          schemaVersion: 1,
          conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
          householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
          channel: 'telegram',
          externalMessageId: 'telegram-message-1',
          receivedAt: '2026-06-30T00:00:00.000Z',
          speaker: { principalRef: 'telegram:user:test' },
          body: '/new',
          attachments: [],
          metadata: { destination: { chatId: 'telegram-chat-42' } },
        })),
      },
      json,
    })).resolves.toMatchObject({
      body: {
        status: 'command-handled',
        command: 'new',
        body: 'Started a new thread.',
        conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J2K',
      },
    });
    expect(operationsPool.connect).toHaveBeenCalledOnce();
  });

  it('passes configured Query tools into the agent system', async () => {
    const queryTools = { query_account_list: {} };
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

  it('builds the spec query toolset by default when no Query tools are injected', async () => {
    const createAgentSystemInstance = vi.fn(() => ({ teams: [], mastraAgents: {} }) as never);

    await bootstrap({
      environment,
      validateModels: vi.fn(async () => undefined),
      verifyPools: vi.fn(async () => undefined),
      createMastraInstance: vi.fn(() => createMastra(environment.DATABASE_MEMORY_URL)),
      createAgentSystemInstance,
    });

    expect(createAgentSystemInstance).toHaveBeenCalledWith(expect.objectContaining({
      queryTools: expect.objectContaining({
        query_account_list: expect.any(Object),
        query_current_balances: expect.any(Object),
        query_categorized_transactions: expect.any(Object),
        query_budget_variance: expect.any(Object),
        query_savings_goal_progress: expect.any(Object),
        query_debt_progress: expect.any(Object),
        query_reconciliation_status: expect.any(Object),
        query_source_freshness: expect.any(Object),
        query_analyst_sandbox: expect.any(Object),
      }),
    }));
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

  it('does not production-bootstrap without an orchestrator agent', async () => {
    const production = { ...environment, NODE_ENV: 'production', LLM_API_KEY: 'test-api-key' };

    await expect(bootstrap({
      environment: production,
      validateModels: vi.fn(async () => undefined),
      createPools: () => ({} as never),
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
      createMastraInstance: vi.fn(() => createMastra(environment.DATABASE_MEMORY_URL)),
      createAgentSystemInstance: vi.fn(() => ({ teams: [], mastraAgents: {} }) as never),
    });

    expect(callOrder.slice(0, 2)).toEqual(['validate', 'pools']);
  });
});
