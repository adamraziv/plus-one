import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { QueryResultSchemaV1 } from '@plus-one/contracts';
import { QueryToolRegistry, ReadOnlySqlValidator } from '@plus-one/query';
import {
  AgentRegistry,
  MastraStructuredAgentAdapter,
  createAnalystSandboxTool,
} from '@plus-one/runtime';
import { loadConfig } from '../../apps/engine/src/config.js';
import { createRoleAgent } from '../../apps/engine/src/mastra/role-agent.js';
import { createQueryTools } from '../../apps/engine/src/tools/query.js';

const liveIt = process.env.LIVE_LLM === '1' ? it : it.skip;
const outputSchema = z.object({ answer: z.string().min(1) }).strict();
const toolId = 'query_account_list';

describe('live Mastra adapter tool calling', () => {
  liveIt('executes a provider-safe active tool before submitting the contractual result', async () => {
    const config = loadConfig();
    const hits: string[] = [];
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
        runTool: async (_toolName, parameters) => {
          hits.push(`${toolId}:${JSON.stringify(parameters)}`);
          return QueryResultSchemaV1.parse({
            schemaName: 'query-result',
            schemaVersion: 1,
            relationName: 'reporting.accounts',
            grain: ['household', 'account'],
            rows: [{ account_id: 1 }],
            fieldDefinitions: ['account_id'],
            sourceReferences: ['relation=reporting.accounts'],
            freshness: 'fresh',
            coverageWarnings: [],
          });
        },
      }),
      analystSandboxTool: createAnalystSandboxTool(),
    });

    const agent = createRoleAgent({
      agentId: 'live-query-tool-agent',
      roleName: 'live-query-tool-agent',
      model: config.models.maker,
      tools,
    });
    const agents = new AgentRegistry();
    agents.register({
      agentId: 'live-query-tool-agent',
      modelId: config.models.maker.id,
      roleKind: 'maker',
      memoryEnabled: false,
      agent,
    });

    const result = await new MastraStructuredAgentAdapter(agents).generate({
      agentId: 'live-query-tool-agent',
      modelId: config.models.maker.id,
      roleKind: 'maker',
      systemPrompt: [
        'You have exactly one active Query tool.',
        'You must call that active tool before answering.',
        'Call it with this exact input JSON: {"householdId":"hh_01JNZQ4A9B8C7D6E5F4G3H2J1K"}.',
        'After the tool call, call submitResult with a non-empty answer string.',
      ].join('\n'),
      messages: [{ role: 'user', content: 'Use the active tool, then answer.' }],
      parentMessages: [],
      memoryEnabled: false,
      activeTools: [toolId],
      toolHistory: [],
      outputSchema,
      maxSteps: 4,
      maxRetries: 1,
      maxToolConcurrency: 1,
      maxProcessorRetries: 0,
      maxOutputBytes: 1024,
      runId: 'run_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      abortSignal: AbortSignal.timeout(60_000),
    });

    expect(hits).toEqual([`${toolId}:["hh_01JNZQ4A9B8C7D6E5F4G3H2J1K"]`]);
    expect(result.answer.length).toBeGreaterThan(0);
  });
});
