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
  signal?: AbortSignal;
}

export interface DeliveryOptions {
  signal?: AbortSignal;
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

  async deliver(response: OrchestratorFinalResponseV1, options: DeliveryOptions = {}): Promise<DeliveryResult> {
    const logger = getLogger('runtime.delivery');
    const startedAt = Date.now();
    const channel = response.delivery.channel;
    throwIfAborted(options.signal);
    logger.info('delivery.started', { fields: { channel } });
    const processingStartedAt = Date.now();
    const processed = runOutputProcessors(
      response,
      this.dependencies.processors ?? [mandatoryPolicyProcessor, channelFormatProcessor],
    );
    logger.info('delivery.processed', {
      fields: {
        channel,
        status: processed.status,
        durationMs: Date.now() - processingStartedAt,
      },
    });
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

    throwIfAborted(options.signal);
    const delivery = await abortable(
      this.dependencies.repository.reserveDelivery({
        deliveryId: this.dependencies.ids.nextDeliveryId(),
        idempotencyKey: createDeliveryKey(response),
        response,
      }),
      options.signal,
    );
    return withLogContext({
      deliveryId: delivery.deliveryId,
      householdId: response.householdId,
      conversationId: response.conversationId,
    }, async () => {
      throwIfAborted(options.signal);
      logger.info('delivery.reserved', {
        fields: {
          channel,
          status: delivery.status,
          durationMs: Date.now() - startedAt,
        },
      });
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

      let sendAttempted = false;
      try {
        throwIfAborted(options.signal);
        const sendStartedAt = Date.now();
        sendAttempted = true;
        const sent = await abortable(this.dependencies.transports[channel].send({
          body: response.body,
          destination: response.delivery.destination,
          format: response.delivery.format,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }), options.signal);
        throwIfAborted(options.signal);
        const delivered = await abortable(this.dependencies.repository.markDelivered(
          response.householdId,
          delivery.deliveryId,
          sent.platformMessageId,
        ), options.signal);
        logger.info('delivery.sent', {
          fields: {
            channel,
            sent: true,
            durationMs: Date.now() - sendStartedAt,
          },
        });
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
        if (options.signal?.aborted) {
          if (sendAttempted) {
            try {
              await this.dependencies.repository.markDeliveryFailed(
                response.householdId,
                delivery.deliveryId,
                'ambiguous',
                'timeout',
              );
            } catch {
              throw abortReason(options.signal);
            }
          }
          throw abortReason(options.signal);
        }
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Delivery aborted.', 'AbortError');
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) throw abortReason(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
