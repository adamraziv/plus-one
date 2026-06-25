import { describe, expect, it, vi } from 'vitest';
import {
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
} from '@plus-one/contracts';
import { bootstrap } from '../../apps/engine/src/bootstrap.js';
import { createRuntimeRoutes } from '../../apps/engine/src/runtime-routes.js';
import { createTeamRuntime } from '../../apps/engine/src/team-runtime.js';

const liveIt = process.env.LIVE_LLM === '1' ? it : it.skip;

describe('orchestrator reasoning-safe live output', () => {
  liveIt('serves the inbound runtime route with a structured Accounting final response', async () => {
    const runtime = await bootstrap();
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
        externalMessageId: `live-reasoning-${Date.now()}`,
        receivedAt: new Date().toISOString(),
        speaker: { principalRef: 'telegram:user:live' },
        body: 'add $10 of buying a burger',
        attachments: [],
        metadata: { destination: { chatId: 'live-chat' } },
      });

      const response = await route.handler({
        req: { json: async () => message },
        json: (body: unknown) => Response.json(body),
      } as never, async () => undefined);
      const parsed = OrchestratorFinalResponseSchemaV1.parse(await response.json());

      expect(response.status).toBe(200);
      expect(parsed.schemaName).toBe('orchestrator-final-response');
      expect(parsed.householdId).toBe(message.householdId);
      expect(parsed.conversationId).toBe(message.conversationId);
      expect(parsed.body.length).toBeGreaterThan(0);
      expect(parsed.body).not.toContain('```json');
      expect(parsed.citations.length).toBeGreaterThan(0);
      expect(runTeamLead).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.objectContaining({ body: 'add $10 of buying a burger' }),
        team: expect.objectContaining({ team: 'accounting' }),
        request: expect.objectContaining({
          schemaName: 'accounting-lead-request',
          intent: 'transaction_capture',
        }),
      }));
    } finally {
      await runtime.close();
    }
  });
});
