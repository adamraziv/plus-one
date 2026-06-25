import { describe, expect, it, vi } from 'vitest';
import {
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  QueryResultSchemaV1,
} from '@plus-one/contracts';
import { QueryToolRegistry, ReadOnlySqlValidator } from '@plus-one/query';
import { createAnalystSandboxTool } from '@plus-one/runtime';
import { bootstrap } from '../../apps/engine/src/bootstrap.js';
import { createRuntimeRoutes } from '../../apps/engine/src/runtime-routes.js';
import { createTeamRuntime } from '../../apps/engine/src/team-runtime.js';
import { createQueryTools } from '../../apps/engine/src/tools/query.js';

const liveIt = process.env.LIVE_LLM === '1' ? it : it.skip;

describe('query live routing acceptance', () => {
  liveIt('answers an account-list question through orchestrator, Query maker tool, checker, and final response', async () => {
    const hits: string[] = [];
    const registry = new QueryToolRegistry({
      allowedRelations: ['reporting.accounts'],
      maxRows: 100,
      validator: new ReadOnlySqlValidator(),
    });
    registry.register({
      toolName: 'account_list',
      relationNames: ['reporting.accounts'],
      sql: 'SELECT account_id, name FROM reporting.accounts WHERE household_id = $1 LIMIT 100',
      parameters: ['$1'],
      limit: 100,
      description: 'List household accounts.',
    });
    const queryTools = createQueryTools({
      registry,
      withEvidenceHandle: async (work) => work({
        runTool: async (toolName, parameters) => {
          hits.push(`${toolName}:${JSON.stringify(parameters)}`);
          return QueryResultSchemaV1.parse({
            schemaName: 'query-result',
            schemaVersion: 1,
            relationName: 'reporting.accounts',
            grain: ['household', 'account'],
            rows: [{ account_id: 'account_live_stub', name: 'Cash' }],
            fieldDefinitions: ['account_id', 'name'],
            sourceReferences: [
              'relation=reporting.accounts',
              'filter=household_id:eq:hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
            ],
            freshness: 'latest available reporting projection',
            coverageWarnings: [],
          });
        },
      }),
      analystSandboxTool: createAnalystSandboxTool(),
    });

    const runtime = await bootstrap({
      queryTools,
      createMastraInstance: (() => ({})) as never,
    });
    try {
      const liveTeamRuntime = createTeamRuntime({ pools: runtime.pools, agentSystem: runtime.agentSystem });
      const runTeamLead = vi.fn(async (input: Parameters<typeof liveTeamRuntime.runTeamLead>[0]) =>
        liveTeamRuntime.runTeamLead(input));
      const [route] = createRuntimeRoutes({
        config: runtime.config,
        agentSystem: runtime.agentSystem,
        teamRuntime: { runTeamLead },
      });
      if (route === undefined || !('handler' in route)) throw new Error('Expected runtime route handler');

      const message = InboundChannelMessageSchemaV1.parse({
        schemaName: 'inbound-channel-message',
        schemaVersion: 1,
        conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        channel: 'telegram',
        externalMessageId: `live-query-${Date.now()}`,
        receivedAt: new Date().toISOString(),
        speaker: { principalRef: 'telegram:user:live' },
        body: 'List our accounts.',
        attachments: [],
        metadata: { destination: { chatId: 'live-query-chat' } },
      });

      const response = await route.handler({
        req: { json: async () => message },
        json: (body: unknown) => Response.json(body),
      } as never, async () => undefined);
      const parsed = OrchestratorFinalResponseSchemaV1.parse(await response.json());

      expect(response.status).toBe(200);
      expect(parsed.body).toContain('Cash');
      expect(parsed.body).toMatch(/\b(?:1|one)\s+account\b/i);
      expect(parsed.body).not.toContain('main orchestrator result was not provided');
      expect(parsed.citations.some((citation) => typeof citation.artifactId === 'string')).toBe(true);
      expect(runTeamLead).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.objectContaining({ body: 'List our accounts.' }),
        team: expect.objectContaining({ team: 'query' }),
        request: expect.anything(),
      }));
      expect(hits.length).toBeGreaterThan(0);
      expect(new Set(hits)).toEqual(new Set([
        'account_list:["hh_01JNZQ4A9B8C7D6E5F4G3H2J1K"]',
      ]));
    } finally {
      await runtime.close();
    }
  }, 120_000);
});
