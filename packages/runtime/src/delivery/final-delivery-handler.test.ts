import { describe, expect, it, vi } from 'vitest';
import { FinalDeliveryHandler, createDeliveryKey } from './final-delivery-handler.js';
import { TransportSendError } from '../gateway/send-result.js';
import {
  DeliveryRecordSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  type DeliveryRecordV1,
  type OutputProcessorResultV1,
} from '@plus-one/contracts';

const response = OrchestratorFinalResponseSchemaV1.parse({
  schemaName: 'orchestrator-final-response',
  schemaVersion: 1,
  responseId: 'response-2026-06-22-001',
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
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
  createdAt: '2026-06-22T10:00:00.000Z',
});

const blocked: OutputProcessorResultV1 = {
  schemaName: 'output-processor-result',
  schemaVersion: 1,
  processorName: 'mandatory-policy',
  processorVersion: 1,
  status: 'blocked',
  reason: 'No.',
  issues: ['missing_disclaimer'],
  retryable: true,
};

function record(status: DeliveryRecordV1['status'], platformMessageId?: string): DeliveryRecordV1 {
  return DeliveryRecordSchemaV1.parse({
    schemaName: 'delivery-record',
    schemaVersion: 1,
    deliveryId: 'delivery_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    householdId: response.householdId,
    conversationId: response.conversationId,
    channel: 'telegram',
    idempotencyKey: createDeliveryKey(response),
    responseHash: response.responseHash,
    status,
    destination: response.delivery.destination,
    ...(platformMessageId === undefined ? {} : { platformMessageId }),
    attemptCount: status === 'pending' ? 0 : 1,
    createdAt: response.createdAt,
    updatedAt: response.createdAt,
  });
}

describe('FinalDeliveryHandler', () => {
  it('blocks before reserving delivery or sending transport output', async () => {
    const repository = {
      reserveDelivery: vi.fn(),
      markDelivered: vi.fn(),
      markDeliveryFailed: vi.fn(),
    };
    const send = vi.fn();
    const handler = new FinalDeliveryHandler({
      repository,
      processors: [{ name: 'mandatory-policy', version: 1, process: () => blocked }],
      transports: { telegram: { send }, slack: { send } },
      ids: { nextDeliveryId: () => 'delivery_01JNZQ4A9B8C7D6E5F4G3H2J1K' },
    });

    await expect(handler.deliver(response)).resolves.toMatchObject({ status: 'blocked' });
    expect(repository.reserveDelivery).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('returns an existing delivered record without sending again', async () => {
    const repository = {
      reserveDelivery: vi.fn(async () => record('delivered', 'telegram-platform-123')),
      markDelivered: vi.fn(),
      markDeliveryFailed: vi.fn(),
    };
    const send = vi.fn();
    const handler = new FinalDeliveryHandler({
      repository,
      transports: { telegram: { send }, slack: { send } },
      ids: { nextDeliveryId: () => 'delivery_01JNZQ4A9B8C7D6E5F4G3H2J1K' },
    });

    await expect(handler.deliver(response)).resolves.toMatchObject({
      status: 'delivered',
      sent: false,
      delivery: { platformMessageId: 'telegram-platform-123' },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('reserves, sends once, and records the platform message id', async () => {
    const repository = {
      reserveDelivery: vi.fn(async () => record('pending')),
      markDelivered: vi.fn(async () => record('delivered', 'telegram-platform-123')),
      markDeliveryFailed: vi.fn(),
    };
    const send = vi.fn(async () => ({ platformMessageId: 'telegram-platform-123' }));
    const handler = new FinalDeliveryHandler({
      repository,
      transports: { telegram: { send }, slack: { send } },
      ids: { nextDeliveryId: () => 'delivery_01JNZQ4A9B8C7D6E5F4G3H2J1K' },
    });

    await expect(handler.deliver(response)).resolves.toMatchObject({ status: 'delivered', sent: true });
    expect(repository.reserveDelivery).toHaveBeenCalledWith({
      deliveryId: 'delivery_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      idempotencyKey: createDeliveryKey(response),
      response,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(repository.markDelivered).toHaveBeenCalledWith(
      response.householdId,
      'delivery_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      'telegram-platform-123',
    );
  });

  it('persists classified transport failures from the adapter', async () => {
    const repository = {
      reserveDelivery: vi.fn(async () => record('pending')),
      markDelivered: vi.fn(),
      markDeliveryFailed: vi.fn(async () => record('failed')),
    };
    const send = vi.fn(async () => {
      throw new TransportSendError({
        category: 'forbidden',
        message: 'Forbidden: bot was blocked by the user',
        retryable: false,
        receiptLookupRequired: false,
      });
    });
    const handler = new FinalDeliveryHandler({
      repository,
      transports: { telegram: { send }, slack: { send } },
      ids: { nextDeliveryId: () => 'delivery_01JNZQ4A9B8C7D6E5F4G3H2J1K' },
    });

    await expect(handler.deliver(response)).resolves.toMatchObject({ status: 'failed', sent: true });
    expect(repository.markDeliveryFailed).toHaveBeenCalledWith(
      response.householdId,
      'delivery_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      'failed',
      'forbidden',
    );
  });

  it('marks receipt-ambiguous transport failures as ambiguous', async () => {
    const repository = {
      reserveDelivery: vi.fn(async () => record('pending')),
      markDelivered: vi.fn(),
      markDeliveryFailed: vi.fn(async () => record('ambiguous')),
    };
    const send = vi.fn(async () => {
      throw new TransportSendError({
        category: 'ambiguous',
        message: 'fetch failed',
        retryable: true,
        receiptLookupRequired: true,
      });
    });
    const handler = new FinalDeliveryHandler({
      repository,
      transports: { telegram: { send }, slack: { send } },
      ids: { nextDeliveryId: () => 'delivery_01JNZQ4A9B8C7D6E5F4G3H2J1K' },
    });

    await expect(handler.deliver(response)).resolves.toMatchObject({ status: 'ambiguous', sent: true });
    expect(repository.markDeliveryFailed).toHaveBeenCalledWith(
      response.householdId,
      'delivery_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      'ambiguous',
      'ambiguous',
    );
  });
});
