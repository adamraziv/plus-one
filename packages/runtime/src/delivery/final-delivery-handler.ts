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
    const processed = runOutputProcessors(
      response,
      this.dependencies.processors ?? [mandatoryPolicyProcessor, channelFormatProcessor],
    );
    if (processed.status === 'blocked') return { status: 'blocked', processorResult: processed };

    const delivery = await this.dependencies.repository.reserveDelivery({
      deliveryId: this.dependencies.ids.nextDeliveryId(),
      idempotencyKey: createDeliveryKey(response),
      response,
    });
    if (delivery.status === 'delivered') return { status: 'delivered', delivery, sent: false };
    if (delivery.status === 'failed' || delivery.status === 'ambiguous') {
      return { status: delivery.status, delivery, sent: false };
    }

    try {
      const sent = await this.dependencies.transports[response.delivery.channel].send({
        body: response.body,
        destination: response.delivery.destination,
        format: response.delivery.format,
      });
      return {
        status: 'delivered',
        sent: true,
        delivery: await this.dependencies.repository.markDelivered(
          response.householdId,
          delivery.deliveryId,
          sent.platformMessageId,
        ),
      };
    } catch (error) {
      const failure = error instanceof TransportSendError
        ? error.failure
        : transportFailureFromUnknown(error);
      const status = failure.receiptLookupRequired || failure.category === 'ambiguous'
        ? 'ambiguous'
        : 'failed';
      return {
        status,
        sent: true,
        delivery: await this.dependencies.repository.markDeliveryFailed(
          response.householdId,
          delivery.deliveryId,
          status,
          failure.category,
        ),
      };
    }
  }
}
