import { describe, expect, it } from 'vitest';
import {
  InboundChannelMessageSchemaV1,
  type InboundChannelMessageV1,
} from '@plus-one/contracts';
import { bootstrap } from '../../apps/engine/src/bootstrap.js';
import { OrchestratorAgent } from '../../apps/engine/src/agents/orchestrator.js';
import { createTeamRuntime } from '../../apps/engine/src/team-runtime.js';

const liveIt = process.env.LIVE_LLM === '1' ? it : it.skip;
const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const conversationId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K';

describe('live system smoke acceptance', () => {
  liveIt('answers an informational prompt and routes a transaction capture request', async () => {
    const { config, agentSystem, pools, close } = await bootstrap();
    const orchestrator = new OrchestratorAgent({
      model: config.models.orchestrator,
      teams: agentSystem.teams,
      teamRuntime: createTeamRuntime({ pools, agentSystem }),
    });

    try {
      const informational = await orchestrator.run({
        message: message('What can you help our household with?', 1),
      });
      expect(informational.policyBoundary).toBe('informational_only');
      expect(informational.body.length).toBeGreaterThan(0);
      expect(informational.citations.map((citation) => citation.label)).toContain('orchestrator-policy');

      const accounting = await orchestrator.run({
        message: message('Add $10 buying a burger', 2),
      });
      expect(accounting.policyBoundary).toBe('personalized_finance');
      expect(accounting.body).toContain('Accounting team status: insufficient_evidence');
      expect(accounting.citations.map((citation) => citation.label)).toContain('accounting:team-result');
    } finally {
      await close();
    }
  }, 120_000);
});

function message(body: string, ordinal: number): InboundChannelMessageV1 {
  return InboundChannelMessageSchemaV1.parse({
    schemaName: 'inbound-channel-message',
    schemaVersion: 1,
    conversationId,
    householdId,
    channel: 'telegram',
    externalMessageId: `live-smoke-${ordinal}-${Date.now()}`,
    receivedAt: new Date().toISOString(),
    speaker: { principalRef: 'telegram:user:live', displayName: 'Live Tester' },
    body,
    attachments: [],
    metadata: { destination: { chatId: 'live-test' } },
  });
}
