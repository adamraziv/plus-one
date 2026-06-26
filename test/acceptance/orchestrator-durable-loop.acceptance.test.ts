import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
} from '@plus-one/contracts';
import { createMastra } from '../../apps/engine/src/mastra.js';
import { createRuntimeRoutes } from '../../apps/engine/src/runtime-routes.js';
import { createOrchestratorLoopWorkflow } from '../../apps/engine/src/workflows/orchestrator-loop.js';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const conversationId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const now = '2026-06-26T00:00:00.000Z';

let context: PostgresTestContext | undefined;
let mastra: ReturnType<typeof createMastra> | undefined;

afterEach(async () => {
  await mastra?.getStorage()?.close();
  mastra = undefined;
  await context?.cleanup();
  context = undefined;
});

function response(body: string) {
  return OrchestratorFinalResponseSchemaV1.parse({
    schemaName: 'orchestrator-final-response',
    schemaVersion: 1,
    responseId: `response_${body.replace(/[^a-z]+/gi, '_')}`,
    householdId,
    conversationId,
    body,
    policyBoundary: 'personalized_finance',
    citations: [{ label: 'orchestrator:test', sourceRef: 'test' }],
    assumptions: [],
    freshness: ['current invocation'],
    disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
    unsupportedCapabilities: [],
    recommendationActions: [],
    delivery: { channel: 'telegram', destination: { chatId: 'live-chat' }, format: 'plain_text' },
    responseHash: 'a'.repeat(64),
    createdAt: now,
  });
}

function message(body: string, externalMessageId: string) {
  return InboundChannelMessageSchemaV1.parse({
    schemaName: 'inbound-channel-message',
    schemaVersion: 1,
    conversationId,
    householdId,
    channel: 'telegram',
    externalMessageId,
    receivedAt: now,
    speaker: { principalRef: 'telegram:user:1' },
    body,
    attachments: [],
    metadata: { destination: { chatId: 'live-chat' } },
  });
}

describe('orchestrator durable loop acceptance', () => {
  it('suspends on clarification and resumes on the next inbound message for the same conversation', async () => {
    context = await createPostgresTestContext('orchestrator_loop');
    const orchestrator = {
      runTurn: vi.fn()
        .mockResolvedValueOnce({ kind: 'ask-user', response: response('Which account was used to pay?') })
        .mockResolvedValueOnce({ kind: 'final', response: response('Recorded the burger transaction.') }),
    };
    mastra = createMastra(
      context.roleUrls.memory,
      {},
      [],
      { 'orchestrator-loop': createOrchestratorLoopWorkflow(orchestrator as never) },
    );
    const [route] = createRuntimeRoutes({
      config: {
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
      },
      agentSystem: { teams: [] } as never,
      teamRuntime: { runTeamLead: vi.fn() },
      orchestrator: orchestrator as never,
      getMastra: () => mastra!,
    });
    if (route === undefined || !('handler' in route)) throw new Error('Expected runtime route handler');

    const first = await route.handler({
      req: { json: async () => message('add $10 of buying a burger', 'message-1') },
      json: (body: unknown) => Response.json(body),
    } as never, async () => undefined);
    const second = await route.handler({
      req: { json: async () => message('From checking account.', 'message-2') },
      json: (body: unknown) => Response.json(body),
    } as never, async () => undefined);

    await expect(first.json()).resolves.toMatchObject({ body: 'Which account was used to pay?' });
    await expect(second.json()).resolves.toMatchObject({ body: 'Recorded the burger transaction.' });
    expect(orchestrator.runTurn.mock.calls.map(([input]) => input.message.body)).toEqual([
      'add $10 of buying a burger',
      'From checking account.',
    ]);
  });
});
