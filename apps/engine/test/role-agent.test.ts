import { describe, expect, it } from 'vitest';
import { QueryToolRegistry, ReadOnlySqlValidator } from '@plus-one/query';
import { createAnalystSandboxTool } from '@plus-one/runtime';
import { createRoleAgent } from '../src/mastra/role-agent.js';
import { createQueryTools } from '../src/tools/query.js';

describe('engine Mastra helper', () => {
  it('creates Query tools with permission ids used by the Query Team definition', () => {
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

    const tools = createQueryTools({
      registry,
      withEvidenceHandle: async (work) => work({
        runTool: async () => ({
          schemaName: 'query-result',
          schemaVersion: 1,
          relationName: 'reporting.accounts',
          grain: ['household', 'account'],
          rows: [],
          fieldDefinitions: ['account_id'],
          sourceReferences: ['relation=reporting.accounts'],
          freshness: 'fresh',
          coverageWarnings: [],
        }),
      }),
      analystSandboxTool: createAnalystSandboxTool(),
    });

    expect(Object.keys(tools).sort()).toEqual(['query.account_list', 'query.analyst_sandbox']);
  });

  it('creates a Mastra agent with code-owned instructions and role tools', () => {
    const agent = createRoleAgent({
      agentId: 'query-maker',
      roleName: 'query-maker',
      model: {
        id: 'openai/gpt-5-mini',
        endpoint: 'https://llm.example.test/v1',
        apiKey: 'test-api-key',
      },
      tools: {},
    });

    expect(agent).toBeDefined();
    expect(typeof agent.generate).toBe('function');
  });
});
