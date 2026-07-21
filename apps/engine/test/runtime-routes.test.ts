import { describe, expect, it, vi } from 'vitest';
import { ChannelCommandResultSchemaV1, InboundChannelMessageSchemaV1 } from '@plus-one/contracts';
import { createRuntimeRoutes } from '../src/runtime-routes.js';

const message = InboundChannelMessageSchemaV1.parse({
  schemaName: 'inbound-channel-message',
  schemaVersion: 1,
  conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  channel: 'telegram',
  externalMessageId: 'telegram-message-1',
  receivedAt: '2026-06-30T00:00:00.000Z',
  speaker: { principalRef: 'telegram:user:test' },
  body: '/new',
  attachments: [],
  metadata: { destination: { chatId: 'telegram-chat-42' } },
});

const config = {
  models: {
    orchestrator: { id: 'test', endpoint: 'https://llm.example.test/v1', apiKey: 'key' },
  },
  turnDeadlineMs: 30_000,
} as never;

describe('runtime routes', () => {
  it('handles /new command before running the orchestrator API path', async () => {
    const run = vi.fn();
    const handle = vi.fn(async () => ChannelCommandResultSchemaV1.parse({
      schemaName: 'channel-command-result',
      schemaVersion: 1,
      command: 'new',
      status: 'handled',
      householdId: message.householdId,
      conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J2K',
      channel: 'telegram',
      delivery: { channel: 'telegram', destination: { chatId: 'telegram-chat-42' }, format: 'plain_text' },
      body: 'Started a new thread.',
      createdAt: '2026-06-30T00:01:00.000Z',
    }));
    const [route] = createRuntimeRoutes({
      config,
      agentSystem: { teams: [] } as never,
      teamRuntime: {} as never,
      orchestrator: { run } as never,
      commands: { handle },
    });
    const json = vi.fn((body: unknown, status?: number) => ({ body, status }));
    expect(route).toBeDefined();
    const handler = (route as unknown as { handler(context: unknown): Promise<unknown> }).handler;

    await expect(handler({
      req: { json: vi.fn(async () => message) },
      json,
    } as never)).resolves.toEqual({
      body: {
        status: 'command-handled',
        command: 'new',
        body: 'Started a new thread.',
        conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J2K',
      },
      status: undefined,
    });
    expect(handle).toHaveBeenCalledWith(message);
    expect(run).not.toHaveBeenCalled();
  });
});
