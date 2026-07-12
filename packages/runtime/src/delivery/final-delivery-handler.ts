import { createHash } from 'node:crypto';
import {
  DeliveryIdSchema,
  type ChannelKindV1,
  type DeliveryRecordV1,
  type OrchestratorFinalResponseV1,
  type OutputProcessorResultV1,
} from '@plus-one/contracts';
import { ulid } from 'ulid';
import { TransportSendError, transportFailureFromUnknown } from '../gateway/send-result.js';
import { getLogger, withLogContext } from '../logging/index.js';
import {
  mandatoryPolicyProcessor,
  channelFormatProcessor,
  runOutputProcessors,
  type OutputProcessor,
} from '../policy/output-processors.js';

export interface TransportSendInput {
  body: string;
  destination: Record<string, unknown>;
  format: 'plain_text' | 'mrkdwn';
}

export interface TransportAdapter {
  send(input: TransportSendInput): Promise<{ platformMessageId: string }>;
  sendTyping?(input: { destination: Record<string, unknown> }): Promise<void>;
  sendInterim?(input: TransportSendInput): Promise<{ platformMessageId: string }>;
  sendOrUpdateStatus?(input: {
    body: string;
    destination: Record<string, unknown>;
    statusMessageId?: string;
  }): Promise<{ platformMessageId: string }>;
  deleteMessage?(input: {
    destination: Record<string, unknown>;
    platformMessageId: string;
  }): Promise<void>;
  editMessage?(input: {
    destination: Record<string, unknown>;
    platformMessageId: string;
    body: string;
    format: 'plain_text' | 'mrkdwn';
  }): Promise<{ platformMessageId: string }>;
}

export interface DeliveryRepositoryPort {
  reserveDelivery(input: {
    deliveryId: string;
    idempotencyKey: string;
    response: OrchestratorFinalResponseV1;
  }): Promise<DeliveryRecordV1>;
  markDelivered(
    householdId: string,
    deliveryId: string,
    platformMessageId: string,
  ): Promise<DeliveryRecordV1>;
  markDeliveryFailed(
    householdId: string,
    deliveryId: string,
    status: 'failed' | 'ambiguous',
    failureCategory: string,
  ): Promise<DeliveryRecordV1>;
}

export type DeliveryResult =
  | { status: 'blocked'; processorResult: OutputProcessorResultV1 }
  | { status: 'delivered'; delivery: DeliveryRecordV1; sent: boolean }
  | { status: 'failed' | 'ambiguous'; delivery: DeliveryRecordV1; sent: boolean };

export const defaultDeliveryIdGenerator = {
  nextDeliveryId: () => DeliveryIdSchema.parse(`delivery_${ulid()}`),
};

export function createDeliveryKey(response: OrchestratorFinalResponseV1): string {
  return createHash('sha256')
    .update(JSON.stringify({
      responseId: response.responseId,
      conversationId: response.conversationId,
      delivery: response.delivery,
      body: response.body,
      responseHash: response.responseHash,
    }))
    .digest('hex');
}

export class FinalDeliveryHandler {
  constructor(private readonly dependencies: {
    repository: DeliveryRepositoryPort;
    transports: Record<ChannelKindV1, TransportAdapter>;
    ids: { nextDeliveryId: () => string };
    processors?: readonly OutputProcessor[];
  }) {}

  async deliver(response: OrchestratorFinalResponseV1): Promise<DeliveryResult> {
    const logger = getLogger('runtime.delivery');
    const startedAt = Date.now();
    const channel = response.delivery.channel;
    logger.info('delivery.started', { fields: { channel } });
    const processed = runOutputProcessors(
      response,
      this.dependencies.processors ?? [mandatoryPolicyProcessor, channelFormatProcessor],
    );
    if (processed.status === 'blocked') {
      logger.info('delivery.completed', {
        fields: {
          channel,
          status: 'blocked',
          failureCategory: 'processor_blocked',
          sent: false,
          durationMs: Date.now() - startedAt,
        },
      });
      return { status: 'blocked', processorResult: processed };
    }

    const delivery = await this.dependencies.repository.reserveDelivery({
      deliveryId: this.dependencies.ids.nextDeliveryId(),
      idempotencyKey: createDeliveryKey(response),
      response,
    });
    return withLogContext({
      deliveryId: delivery.deliveryId,
      householdId: response.householdId,
      conversationId: response.conversationId,
    }, async () => {
      if (delivery.status === 'delivered') {
        logger.info('delivery.completed', {
          fields: {
            channel,
            status: 'delivered',
            sent: false,
            durationMs: Date.now() - startedAt,
          },
        });
        return { status: 'delivered', delivery, sent: false };
      }
      if (delivery.status === 'failed' || delivery.status === 'ambiguous') {
        logger.warn('delivery.failed', {
          fields: {
            channel,
            status: delivery.status,
            failureCategory: delivery.failureCategory,
            sent: false,
            durationMs: Date.now() - startedAt,
          },
        });
        return { status: delivery.status, delivery, sent: false };
      }

      try {
        const sent = await this.dependencies.transports[channel].send({
          body: response.body,
          destination: response.delivery.destination,
          format: response.delivery.format,
        });
        const delivered = await this.dependencies.repository.markDelivered(
          response.householdId,
          delivery.deliveryId,
          sent.platformMessageId,
        );
        logger.info('delivery.completed', {
          fields: {
            channel,
            status: 'delivered',
            sent: true,
            durationMs: Date.now() - startedAt,
          },
        });
        return { status: 'delivered', sent: true, delivery: delivered };
      } catch (error) {
        const failure = error instanceof TransportSendError
          ? error.failure
          : transportFailureFromUnknown(error);
        const status = failure.receiptLookupRequired || failure.category === 'ambiguous'
          ? 'ambiguous'
          : 'failed';
        const failed = await this.dependencies.repository.markDeliveryFailed(
          response.householdId,
          delivery.deliveryId,
          status,
          failure.category,
        );
        logger.warn('delivery.failed', {
          fields: {
            channel,
            status,
            failureCategory: failure.category,
            sent: true,
            durationMs: Date.now() - startedAt,
          },
        });
        return { status, sent: true, delivery: failed };
      }
    });
  }
}
