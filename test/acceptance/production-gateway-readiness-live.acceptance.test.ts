import { afterEach, describe, expect, it } from 'vitest';
import { InboundChannelMessageSchemaV1 } from '@plus-one/contracts';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';
import {
  startProductionGatewayServer,
  type ProductionGatewayServerHandle,
} from '../helpers/production-gateway-server.js';

let context: PostgresTestContext | undefined;
let server: ProductionGatewayServerHandle | undefined;

afterEach(async () => {
  await server?.stop();
  await context?.cleanup();
  server = undefined;
  context = undefined;
});

describe('production gateway readiness through the live runtime', () => {
  it('becomes ready, serves inbound work, and shuts down cleanly', async () => {
    context = await createPostgresTestContext('production_gateway_readiness');
    server = await startProductionGatewayServer({
      env: databaseEnvironment(context),
      modelResponder: () => ({
        finishReason: 'stop',
        message: { role: 'assistant', content: 'The production gateway is ready.' },
      }),
    });

    const ready = await fetch(`${server.baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready' });
    const live = await fetch(`${server.baseUrl}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'live' });

    const inbound = await fetch(`${server.baseUrl}/plus-one/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(InboundChannelMessageSchemaV1.parse({
        schemaName: 'inbound-channel-message',
        schemaVersion: 1,
        conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        channel: 'telegram',
        externalMessageId: 'telegram:production-gateway-readiness:1',
        receivedAt: '2026-07-20T08:00:00.000Z',
        speaker: { principalRef: 'telegram:user:42', displayName: 'Adam' },
        body: 'hello production gateway',
        attachments: [],
        metadata: { destination: { chatId: 'telegram-chat-42' } },
      })),
    });
    expect(inbound.status).toBe(200);
    expect(await inbound.json()).toMatchObject({ body: 'The production gateway is ready.' });

    await server.stop();
  }, 120_000);
});

function databaseEnvironment(testContext: PostgresTestContext): NodeJS.ProcessEnv {
  return {
    DATABASE_MIGRATOR_URL: testContext.migratorUrl,
    DATABASE_ACCOUNTING_URL: testContext.roleUrls.accounting,
    DATABASE_PLANNING_URL: testContext.roleUrls.planning,
    DATABASE_OPERATIONS_URL: testContext.roleUrls.operations,
    DATABASE_QUERY_URL: testContext.roleUrls.query,
    DATABASE_MEMORY_URL: testContext.roleUrls.memory,
  };
}
