import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
} from '@plus-one/contracts';
import { accountingTeamDefinition } from '@plus-one/accounting';
import { OrchestratorAgent } from '../../apps/engine/src/agents/orchestrator.js';
import { createRuntimeRoutes } from '../../apps/engine/src/runtime-routes.js';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const conversationId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const now = '2026-06-24T00:00:00.000Z';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('accounting live routing acceptance', () => {
  it('serves the inbound runtime route and returns the orchestrator response', async () => {
    const run = vi.spyOn(OrchestratorAgent.prototype, 'run').mockResolvedValue(
      OrchestratorFinalResponseSchemaV1.parse({
        schemaName: 'orchestrator-final-response',
        schemaVersion: 1,
        responseId: 'response_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        householdId,
        conversationId,
        body: 'Accounting team status: verified',
        policyBoundary: 'personalized_finance',
        citations: [{ label: 'accounting:claim-1', artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K' }],
        assumptions: [],
        freshness: ['current invocation'],
        disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
        unsupportedCapabilities: [],
        recommendationActions: [],
        delivery: { channel: 'telegram', destination: { chatId: 'live-chat' }, format: 'plain_text' },
        responseHash: 'a'.repeat(64),
        createdAt: now,
      }),
    );
    const [route] = createRuntimeRoutes({
      config: {
        nodeEnv: 'test',
        host: '127.0.0.1',
        port: 4111,
        turnDeadlineMs: 60_000,
        database: { poolUrls: {} } as never,
        models: {
          orchestrator: { id: 'openai/gpt-5', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
          lead: { id: 'openai/gpt-5', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
          maker: { id: 'openai/gpt-5-mini', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
          checker: { id: 'openai/gpt-5', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
          research: { id: 'openai/gpt-5', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
        },
      },
      agentSystem: { teams: [accountingTeamDefinition] } as never,
      teamRuntime: {
        runTeamLead: vi.fn(),
        resumePendingMutation: async () => { throw new Error('Unexpected mutation resume'); },
        cancelPendingMutation: async () => { throw new Error('Unexpected mutation cancellation'); },
      },
    });
    const message = InboundChannelMessageSchemaV1.parse({
      schemaName: 'inbound-channel-message',
      schemaVersion: 1,
      conversationId,
      householdId,
      channel: 'telegram',
      externalMessageId: 'live-burger-001',
      receivedAt: now,
      speaker: { principalRef: 'telegram:user:live' },
      body: 'add $10 of buying a burger',
      attachments: [],
      metadata: { destination: { chatId: 'live-chat' } },
    });

    expect(route?.path).toBe('/plus-one/inbound');
    expect(route?.method).toBe('POST');
    if (route === undefined || !('handler' in route)) throw new Error('Expected runtime route handler');

    const response = await route.handler({
      req: { json: async () => message },
      json: (body: unknown) => Response.json(body),
    } as never, async () => undefined);

    expect(run).toHaveBeenCalledWith({
      message,
      signal: expect.any(AbortSignal),
    });
    await expect(response.json()).resolves.toMatchObject({
      body: 'Accounting team status: verified',
    });
  });
});
