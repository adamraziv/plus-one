import { describe, expect, it, vi } from 'vitest';
import { QueryResultSchemaV1 } from '@plus-one/contracts';
import { QueryToolRegistry, ReadOnlySqlValidator } from '@plus-one/query';
import { createAnalystSandboxTool } from '@plus-one/runtime';
import { createRoleAgent, toMastraModel } from '../src/mastra/role-agent.js';
import { createQueryTools } from '../src/tools/query.js';

describe('engine Mastra helper', () => {
  it('creates Query tools with permission ids used by the Query Team definition', async () => {
    const registry = new QueryToolRegistry({
      allowedRelations: ['reporting.accounts'],
      maxRows: 100,
      validator: new ReadOnlySqlValidator(),
    });
    registry.register({
      toolName: 'account_list',
      relationNames: ['reporting.accounts'],
      sql: 'SELECT account_id FROM reporting.accounts WHERE household_id = $1 LIMIT 100',
      parameters: ['$1'],
      limit: 100,
      description: 'List accounts.',
    });

    const runTool = vi.fn(async (_toolName: string, parameters: readonly unknown[]) => {
      void parameters;
      return QueryResultSchemaV1.parse({
        schemaName: 'query-result',
        schemaVersion: 1,
        relationName: 'reporting.accounts',
        grain: ['household', 'account'],
        rows: [],
        fieldDefinitions: ['account_id'],
        sourceReferences: ['relation=reporting.accounts'],
        freshness: 'fresh',
        coverageWarnings: [],
      });
    });
    const tools = createQueryTools({
      registry,
      withEvidenceHandle: async (work) => work({ runTool }),
      analystSandboxTool: createAnalystSandboxTool(),
    });

    expect(Object.keys(tools).sort()).toEqual(['query_account_list', 'query_analyst_sandbox']);
    const accountList = tools.query_account_list as unknown as {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    };
    await accountList.execute({
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    }, {});

    expect(runTool).toHaveBeenCalledWith(
      'account_list',
      ['hh_01JNZQ4A9B8C7D6E5F4G3H2J1K'],
    );
  });

  it('creates a generic non-Query Mastra role agent with code-owned instructions', () => {
    const agent = createRoleAgent({
      agentId: 'accounting-lead',
      roleName: 'accounting-lead',
      model: {
        id: 'openai/gpt-5',
        endpoint: 'https://llm.example.test/v1',
        apiKey: 'test-api-key',
      },
      tools: {},
    });

    expect(agent).toBeDefined();
    expect(typeof agent.generate).toBe('function');
  });

  it('requires canonical provider/model ids for Mastra', () => {
    expect(() => toMastraModel({
      id: 'deepseek-v4-flash',
      endpoint: 'https://llm.example.test/v1',
      apiKey: 'test-api-key',
    })).toThrow(/provider\/model/);

    expect(toMastraModel({
      id: 'deepseek/deepseek-v4-flash',
      endpoint: 'https://llm.example.test/v1',
      apiKey: 'test-api-key',
    })).toMatchObject({
      id: 'deepseek/deepseek-v4-flash',
      url: 'https://llm.example.test/v1',
    });
  });
});
