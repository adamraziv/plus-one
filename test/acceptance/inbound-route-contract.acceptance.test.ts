import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountingTeamDefinition } from '@plus-one/accounting';
import { OrchestratorAgent } from '../../apps/engine/src/agents/orchestrator.js';
import { createRuntimeRoutes } from '../../apps/engine/src/runtime-routes.js';

const config = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 4111,
  database: { poolUrls: {} } as never,
  models: {
    orchestrator: { id: 'openai/gpt-5', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
    lead: { id: 'openai/gpt-5', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
    maker: { id: 'openai/gpt-5-mini', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
    checker: { id: 'openai/gpt-5', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
    research: { id: 'openai/gpt-5', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
  },
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('inbound route contract', () => {
  it('returns 400 for invalid payloads without invoking the orchestrator', async () => {
    const run = vi.spyOn(OrchestratorAgent.prototype, 'run');
    const [route] = createRuntimeRoutes({
      config: config as never,
      agentSystem: { teams: [accountingTeamDefinition] } as never,
      teamRuntime: { runTeamLead: vi.fn() },
    });
    if (route === undefined || !('handler' in route)) throw new Error('Expected runtime route handler');

    const response = await route.handler({
      req: {
        json: async () => ({
          schemaName: 'inbound-channel-message',
          schemaVersion: 1,
          conversationId: 'conversation_bad',
          householdId: 'hh_bad',
          channel: 'telegram',
          externalMessageId: 'bad-message-1',
          receivedAt: '2026-06-30T00:00:00.000Z',
          speaker: { principalRef: 'telegram:user:bad' },
          body: 'hello',
          attachments: [],
          metadata: { destination: { chatId: 'bad-chat' } },
        }),
      },
      json: (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    } as never);

    expect(run).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid inbound-channel-message',
      issues: [
        expect.objectContaining({ path: 'conversationId' }),
        expect.objectContaining({ path: 'householdId' }),
      ],
    });
  });

  it('keeps the custom route on /plus-one/inbound', () => {
    const [route] = createRuntimeRoutes({
      config: config as never,
      agentSystem: { teams: [accountingTeamDefinition] } as never,
      teamRuntime: { runTeamLead: vi.fn() },
    });

    expect(route).toMatchObject({
      path: '/plus-one/inbound',
      method: 'POST',
    });
  });
});
