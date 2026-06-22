import { describe, expect, it, vi } from 'vitest';
import {
  DeliveryRecordSchemaV1,
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  type OutputProcessorResultV1,
} from '@plus-one/contracts';
import { OrchestratorIngress } from './orchestrator-ingress.js';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const conversationId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const now = '2026-06-22T10:00:00.000Z';

const message = InboundChannelMessageSchemaV1.parse({
  schemaName: 'inbound-channel-message',
  schemaVersion: 1,
  conversationId,
  householdId,
  channel: 'telegram',
  externalMessageId: 'telegram-message-1',
  receivedAt: now,
  speaker: { principalRef: 'telegram:user:1' },
  body: 'How did we do?',
  attachments: [],
  metadata: {},
});

const response = OrchestratorFinalResponseSchemaV1.parse({
  schemaName: 'orchestrator-final-response',
  schemaVersion: 1,
  responseId: 'response-2026-06-22-001',
  householdId,
  conversationId,
  body: 'You were under budget. Plus One is an AI assistant, not a licensed financial professional.',
  policyBoundary: 'personalized_finance',
  citations: [{ label: 'June budget variance', artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K' }],
  assumptions: ['June transactions are fully imported.'],
  freshness: ['Budget projection refreshed 2026-06-22.'],
  disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
  unsupportedCapabilities: [],
  recommendationActions: ['Move $50 from dining to groceries next month.'],
  delivery: { channel: 'telegram', destination: { chatId: 'telegram-chat-42' }, format: 'plain_text' },
  responseHash: 'a'.repeat(64),
  createdAt: now,
});

const delivery = DeliveryRecordSchemaV1.parse({
  schemaName: 'delivery-record',
  schemaVersion: 1,
  deliveryId: 'delivery_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  householdId,
  conversationId,
  channel: 'telegram',
  idempotencyKey: 'delivery-key-1',
  responseHash: response.responseHash,
  status: 'delivered',
  destination: response.delivery.destination,
  platformMessageId: 'telegram-platform-123',
  attemptCount: 1,
  createdAt: now,
  updatedAt: now,
});

const blocked: OutputProcessorResultV1 = {
  schemaName: 'output-processor-result',
  schemaVersion: 1,
  processorName: 'mandatory-policy',
  processorVersion: 1,
  status: 'blocked',
  reason: 'Missing disclaimer.',
  issues: ['missing_disclaimer'],
  retryable: true,
};

describe('OrchestratorIngress', () => {
  it('records a new inbound message, invokes one orchestrator, then delivers final output', async () => {
    const recordInboundMessage = vi.fn(async () => ({ inserted: true }));
    const run = vi.fn(async () => response);
    const deliver = vi.fn(async () => ({ status: 'delivered' as const, sent: true as const, delivery }));
    const ingress = new OrchestratorIngress({
      inbound: { recordInboundMessage },
      orchestrator: { run },
      delivery: { deliver },
    });

    await expect(ingress.handleInbound(message)).resolves.toMatchObject({ status: 'delivered' });
    expect(recordInboundMessage).toHaveBeenCalledWith(message);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ message });
    expect(deliver).toHaveBeenCalledWith(response);
  });

  it('skips duplicate inbound messages before orchestrator or delivery work', async () => {
    const run = vi.fn();
    const deliver = vi.fn();
    const ingress = new OrchestratorIngress({
      inbound: { recordInboundMessage: vi.fn(async () => ({ inserted: false })) },
      orchestrator: { run },
      delivery: { deliver },
    });

    await expect(ingress.handleInbound(message)).resolves.toEqual({ status: 'duplicate' });
    expect(run).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('returns processor-blocked delivery without claiming success', async () => {
    const ingress = new OrchestratorIngress({
      inbound: { recordInboundMessage: vi.fn(async () => ({ inserted: true })) },
      orchestrator: { run: vi.fn(async () => response) },
      delivery: { deliver: vi.fn(async () => ({ status: 'blocked' as const, processorResult: blocked })) },
    });

    await expect(ingress.handleInbound(message)).resolves.toMatchObject({
      status: 'blocked',
      processorResult: blocked,
    });
  });
});
