import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChannelCommandResultSchemaV1,
  DeliveryRecordSchemaV1,
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
} from '@plus-one/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ChannelGateway } from './channel-gateway.js';
import { configureLogging } from '../logging/index.js';

const message = InboundChannelMessageSchemaV1.parse({
  schemaName: 'inbound-channel-message',
  schemaVersion: 1,
  conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  channel: 'telegram',
  externalMessageId: 'telegram:42:100',
  receivedAt: '2026-07-06T00:00:00.000Z',
  speaker: { principalRef: 'telegram:user:42' },
  body: 'What did we spend this month?',
  attachments: [],
  metadata: { destination: { chatId: 'telegram-chat-42' } },
});

const response = OrchestratorFinalResponseSchemaV1.parse({
  schemaName: 'orchestrator-final-response',
  schemaVersion: 1,
  responseId: 'response-1',
  householdId: message.householdId,
  conversationId: message.conversationId,
  body: 'You spent $100. Plus One is an AI assistant, not a licensed financial professional.',
  policyBoundary: 'personalized_finance',
  citations: [{ label: 'spending report' }],
  assumptions: [],
  freshness: ['current invocation only'],
  disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
  unsupportedCapabilities: [],
  recommendationActions: [],
  delivery: { channel: 'telegram', destination: { chatId: 'telegram-chat-42' }, format: 'plain_text' },
  responseHash: 'a'.repeat(64),
  createdAt: '2026-07-06T00:00:01.000Z',
});

const deliveredRecord = DeliveryRecordSchemaV1.parse({
  schemaName: 'delivery-record',
  schemaVersion: 1,
  deliveryId: 'delivery_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  householdId: message.householdId,
  conversationId: message.conversationId,
  channel: 'telegram',
  idempotencyKey: 'gateway-test-key',
  responseHash: response.responseHash,
  status: 'delivered',
  destination: { chatId: 'telegram-chat-42' },
  platformMessageId: '200',
  attemptCount: 1,
  createdAt: '2026-07-06T00:00:01.000Z',
  updatedAt: '2026-07-06T00:00:01.000Z',
});

const commandResult = ChannelCommandResultSchemaV1.parse({
  schemaName: 'channel-command-result',
  schemaVersion: 1,
  command: 'new',
  status: 'handled',
  householdId: message.householdId,
  conversationId: message.conversationId,
  channel: 'telegram',
  delivery: { channel: 'telegram', destination: { chatId: 'telegram-chat-42' }, format: 'plain_text' },
  body: 'Started a new thread.',
  createdAt: '2026-07-06T00:00:00.000Z',
});

describe('ChannelGateway', () => {
  it('handles commands before typing and before recording inbound', async () => {
    const sink = { emit: vi.fn(async () => undefined) };
    const gateway = new ChannelGateway({
      inbound: { recordInboundMessage: vi.fn() },
      commands: { handle: vi.fn(async () => commandResult) },
      orchestrator: { run: vi.fn() },
      delivery: { deliver: vi.fn() },
      sink,
    });

    await expect(gateway.handleInbound(message)).resolves.toMatchObject({ status: 'command-handled' });
    expect(sink.emit).not.toHaveBeenCalled();
  });

  it('returns duplicate without starting typing or orchestrator work', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-gateway-'));
    const logging = configureLogging({ homeDirectory });
    const sink = { emit: vi.fn(async () => undefined) };
    const gateway = new ChannelGateway({
      inbound: { recordInboundMessage: vi.fn(async () => ({ inserted: false })) },
      orchestrator: { run: vi.fn() },
      delivery: { deliver: vi.fn() },
      sink,
    });

    try {
      await expect(gateway.handleInbound(message)).resolves.toEqual({ status: 'duplicate' });
      expect(sink.emit).not.toHaveBeenCalled();
      const agentLog = await readFile(join(homeDirectory, 'logs', 'agent.log'), 'utf8');
      expect(agentLog).toContain('gateway.inbound.duplicate');
      expect(agentLog).toContain('conversationId=conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K');
      expect(agentLog).toContain('householdId=hh_01JNZQ4A9B8C7D6E5F4G3H2J1K');
      expect(agentLog).not.toContain('What did we spend this month?');
    } finally {
      logging.close();
    }
  });

  it('emits typing, runs orchestrator, delivers final, and stops typing', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-gateway-'));
    const logging = configureLogging({ homeDirectory });
    const sink = { emit: vi.fn(async () => undefined) };
    const gateway = new ChannelGateway({
      inbound: { recordInboundMessage: vi.fn(async () => ({ inserted: true })) },
      orchestrator: { run: vi.fn(async () => response) },
      delivery: { deliver: vi.fn(async () => ({ status: 'delivered' as const, sent: true, delivery: deliveredRecord })) },
      sink,
      heartbeat: { typingEveryMs: 60_000 },
    });

    try {
      await expect(gateway.handleInbound(message)).resolves.toMatchObject({ status: 'delivered' });
      expect(sink.emit).toHaveBeenCalledWith({ kind: 'typing.start', target: expect.any(Object) });
      expect(sink.emit).toHaveBeenCalledWith({ kind: 'final.delivery-started', target: expect.any(Object) });
      expect(sink.emit).toHaveBeenCalledWith({ kind: 'final.delivered', target: expect.any(Object), platformMessageId: '200' });
      expect(sink.emit).toHaveBeenLastCalledWith({ kind: 'typing.stop', target: expect.any(Object) });
      const agentLog = await readFile(join(homeDirectory, 'logs', 'agent.log'), 'utf8');
      expect(agentLog).toContain('gateway.inbound.accepted');
      expect(agentLog).toContain('conversationId=conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K');
      expect(agentLog).toContain('householdId=hh_01JNZQ4A9B8C7D6E5F4G3H2J1K');
      expect(agentLog).not.toContain('What did we spend this month?');
    } finally {
      logging.close();
    }
  });

  it('returns a failed gateway result and stops typing when orchestration throws', async () => {
    const sink = { emit: vi.fn(async () => undefined) };
    const gateway = new ChannelGateway({
      inbound: { recordInboundMessage: vi.fn(async () => ({ inserted: true })) },
      orchestrator: { run: vi.fn(async () => { throw new Error('model unavailable'); }) },
      delivery: { deliver: vi.fn() },
      sink,
      heartbeat: { typingEveryMs: 60_000 },
    });

    await expect(gateway.handleInbound(message)).resolves.toEqual({
      status: 'failed',
      error: 'orchestrator_failed',
      sent: false,
    });
    expect(sink.emit).toHaveBeenCalledWith({
      kind: 'final.failed',
      target: expect.any(Object),
      status: 'failed',
      reason: 'orchestrator_failed',
    });
    expect(sink.emit).toHaveBeenLastCalledWith({ kind: 'typing.stop', target: expect.any(Object) });
  });

  it('does not create timer-driven status events while a delegated turn is running', async () => {
    const sink = { emit: vi.fn(async () => undefined) };
    const gateway = new ChannelGateway({
      inbound: { recordInboundMessage: vi.fn(async () => ({ inserted: true })) },
      orchestrator: {
        run: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return response;
        }),
      },
      delivery: { deliver: vi.fn(async () => ({ status: 'delivered' as const, sent: true, delivery: deliveredRecord })) },
      sink,
      heartbeat: { typingEveryMs: 1_000 },
      turnDeadlineMs: 1_000,
    });

    await expect(gateway.handleInbound(message)).resolves.toMatchObject({ status: 'delivered' });
    expect(sink.emit).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'status.update' }));
  });

  it('passes the gateway deadline signal to orchestration and reports a timeout safely', async () => {
    const run = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const gateway = new ChannelGateway({
      inbound: { recordInboundMessage: vi.fn(async () => ({ inserted: true })) },
      orchestrator: { run },
      delivery: { deliver: vi.fn() },
      turnDeadlineMs: 1,
    });

    await expect(gateway.handleInbound(message)).resolves.toEqual({
      status: 'failed', error: 'orchestrator_timed_out', sent: false,
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ message, signal: expect.any(AbortSignal) }));
  });

  it('propagates delivery persistence failures and stops typing', async () => {
    const persistenceError = new Error('operations database unavailable');
    const sink = { emit: vi.fn(async () => undefined) };
    const gateway = new ChannelGateway({
      inbound: { recordInboundMessage: vi.fn(async () => ({ inserted: true })) },
      orchestrator: { run: vi.fn(async () => response) },
      delivery: { deliver: vi.fn(async () => { throw persistenceError; }) },
      sink,
      heartbeat: { typingEveryMs: 60_000 },
    });

    await expect(gateway.handleInbound(message)).rejects.toBe(persistenceError);
    expect(sink.emit).toHaveBeenCalledWith({ kind: 'final.delivery-started', target: expect.any(Object) });
    expect(sink.emit).toHaveBeenLastCalledWith({ kind: 'typing.stop', target: expect.any(Object) });
  });

  it('does not let final lifecycle event failures change delivered results', async () => {
    const sink = {
      emit: vi.fn(async (event: { kind: string }) => {
        if (event.kind.startsWith('final.')) throw new Error('status transport unavailable');
      }),
    };
    const gateway = new ChannelGateway({
      inbound: { recordInboundMessage: vi.fn(async () => ({ inserted: true })) },
      orchestrator: { run: vi.fn(async () => response) },
      delivery: { deliver: vi.fn(async () => ({ status: 'delivered' as const, sent: true, delivery: deliveredRecord })) },
      sink,
      heartbeat: { typingEveryMs: 60_000 },
    });

    await expect(gateway.handleInbound(message)).resolves.toMatchObject({ status: 'delivered' });
  });
});
