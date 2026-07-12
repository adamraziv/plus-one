import {
  ChannelCommandResultSchemaV1,
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  type ChannelCommandResultV1,
  type InboundChannelMessageV1,
  type OrchestratorFinalResponseV1,
  type OutputProcessorResultV1,
} from '@plus-one/contracts';
import type { DeliveryOptions, DeliveryResult } from '../delivery/final-delivery-handler.js';
import { createRequestId, getLogger, withLogContext } from '../logging/index.js';
import { ActiveTurnRegistry } from './active-turn-registry.js';
import {
  noopChannelEventSink,
  targetFromInboundMessage,
  type ChannelEventSink,
} from './channel-events.js';
import { startGatewayHeartbeat } from './status-loop.js';

export type ChannelGatewayResult =
  | { status: 'duplicate' }
  | { status: 'queued' }
  | { status: 'closed' }
  | { status: 'command-handled'; command: 'new'; body: string; conversationId: string }
  | { status: 'blocked'; processorResult: OutputProcessorResultV1 }
  | { status: 'failed'; error: string; sent: false }
  | { status: 'delivered' | 'failed' | 'ambiguous'; delivery: DeliveryResult; sent: boolean };

export class ChannelGateway {
  private readonly turns: ActiveTurnRegistry<ChannelGatewayResult>;
  private readonly logger = getLogger('gateway.channel');

  constructor(private readonly dependencies: {
    inbound: { recordInboundMessage(message: InboundChannelMessageV1): Promise<{ inserted: boolean }> };
    orchestrator: {
      run(input: { message: InboundChannelMessageV1; signal: AbortSignal }): Promise<OrchestratorFinalResponseV1>;
    };
    delivery: { deliver(response: OrchestratorFinalResponseV1, options?: DeliveryOptions): Promise<DeliveryResult> };
    commands?: { handle(message: InboundChannelMessageV1): Promise<ChannelCommandResultV1 | undefined> };
    sink?: ChannelEventSink;
    turns?: ActiveTurnRegistry<ChannelGatewayResult>;
    heartbeat?: { typingEveryMs: number };
    turnDeadlineMs?: number;
  }) {
    this.turns = dependencies.turns ?? new ActiveTurnRegistry<ChannelGatewayResult>();
  }

  async handleInbound(candidate: InboundChannelMessageV1): Promise<ChannelGatewayResult> {
    const message = InboundChannelMessageSchemaV1.parse(candidate);
    return withLogContext({
      requestId: createRequestId(),
      conversationId: message.conversationId,
      householdId: message.householdId,
    }, async () => this.handleValidatedInbound(message));
  }

  private async handleValidatedInbound(message: InboundChannelMessageV1): Promise<ChannelGatewayResult> {
    const command = ChannelCommandResultSchemaV1.optional().parse(
      await this.dependencies.commands?.handle(message),
    );
    if (command !== undefined) {
      return {
        status: 'command-handled',
        command: command.command,
        body: command.body,
        conversationId: command.conversationId,
      };
    }

    const recorded = await this.dependencies.inbound.recordInboundMessage(message);
    if (!recorded.inserted) {
      this.logger.info('gateway.inbound.duplicate', { fields: { channel: message.channel } });
      return { status: 'duplicate' };
    }
    this.logger.info('gateway.inbound.accepted', { fields: { channel: message.channel } });

    const turnStartedAt = Date.now();
    const signal = AbortSignal.timeout(this.dependencies.turnDeadlineMs ?? 60_000);
    const submitted = await this.turns.submit(
      message.conversationId,
      async () => this.runRecordedTurn(message, signal, turnStartedAt),
    );
    if (submitted.status === 'started') return submitted.result;
    if (submitted.status === 'queued') {
      this.logger.info('gateway.inbound.queued', { fields: { channel: message.channel } });
    }
    return submitted;
  }

  async shutdown(): Promise<void> {
    await this.turns.shutdown();
  }

  private async runRecordedTurn(
    message: InboundChannelMessageV1,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ChannelGatewayResult> {
    const sink = this.dependencies.sink ?? noopChannelEventSink;
    const target = targetFromInboundMessage(message);
    const heartbeat = startGatewayHeartbeat({
      sink,
      target,
      typingEveryMs: this.dependencies.heartbeat?.typingEveryMs ?? 2_000,
      signal,
    });
    try {
      let response: OrchestratorFinalResponseV1;
      try {
        if (signal.aborted) throw signal.reason ?? new DOMException('Channel turn aborted.', 'AbortError');
        response = OrchestratorFinalResponseSchemaV1.parse(
          await abortable(this.dependencies.orchestrator.run({ message, signal }), signal),
        );
      } catch {
        if (signal.aborted) {
          this.logger.warn('gateway.turn.timed_out', {
            fields: { channel: message.channel, durationMs: Date.now() - startedAt },
          });
          void emitGatewayEvent(sink, {
            kind: 'final.failed',
            target,
            status: 'failed',
            reason: 'orchestrator_timed_out',
          });
          return { status: 'failed', error: 'orchestrator_timed_out', sent: false };
        }
        void emitGatewayEvent(sink, {
          kind: 'final.failed',
          target,
          status: 'failed',
          reason: 'orchestrator_failed',
        }, signal);
        return { status: 'failed', error: 'orchestrator_failed', sent: false };
      }
      if (signal.aborted) {
        this.logger.warn('gateway.turn.timed_out', {
          fields: { channel: message.channel, durationMs: Date.now() - startedAt },
        });
        void emitGatewayEvent(sink, {
          kind: 'final.failed',
          target,
          status: 'failed',
          reason: 'orchestrator_timed_out',
        });
        return { status: 'failed', error: 'orchestrator_timed_out', sent: false };
      }
      await emitGatewayEvent(sink, { kind: 'final.delivery-started', target }, signal);
      let delivery: DeliveryResult;
      try {
        if (signal.aborted) throw signal.reason ?? new DOMException('Channel turn aborted.', 'AbortError');
        delivery = await abortable(
          this.dependencies.delivery.deliver(response, { signal }),
          signal,
        );
      } catch (error) {
        if (signal.aborted) {
          this.logger.warn('gateway.turn.timed_out', {
            fields: { channel: message.channel, durationMs: Date.now() - startedAt },
          });
          void emitGatewayEvent(sink, {
            kind: 'final.failed',
            target,
            status: 'failed',
            reason: 'orchestrator_timed_out',
          });
          return { status: 'failed', error: 'orchestrator_timed_out', sent: false };
        }
        void emitGatewayEvent(sink, {
          kind: 'final.failed',
          target,
          status: 'failed',
          reason: 'delivery_failed',
        }, signal);
        throw error;
      }
      if (signal.aborted && delivery.status !== 'delivered') {
        this.logger.warn('gateway.turn.timed_out', {
          fields: { channel: message.channel, durationMs: Date.now() - startedAt },
        });
        void emitGatewayEvent(sink, {
          kind: 'final.failed',
          target,
          status: 'failed',
          reason: 'orchestrator_timed_out',
        });
        return { status: 'failed', error: 'orchestrator_timed_out', sent: false };
      }
      if (delivery.status === 'blocked') {
        await emitGatewayEvent(sink, {
          kind: 'final.failed',
          target,
          status: 'blocked',
          reason: delivery.processorResult.reason,
        }, signal);
        return { status: 'blocked', processorResult: delivery.processorResult };
      }
      if (delivery.status === 'delivered') {
        await emitGatewayEvent(sink, {
          kind: 'final.delivered',
          target,
          ...(delivery.delivery.platformMessageId === undefined
            ? {}
            : { platformMessageId: delivery.delivery.platformMessageId }),
        }, signal.aborted ? undefined : signal);
      } else {
        await emitGatewayEvent(sink, {
          kind: 'final.failed',
          target,
          status: delivery.status,
          reason: delivery.delivery.failureCategory ?? delivery.status,
        }, signal);
      }
      return { status: delivery.status, delivery, sent: delivery.sent };
    } finally {
      await heartbeat.close();
    }
  }
}

async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) throw signal.reason ?? new DOMException('Channel turn aborted.', 'AbortError');
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Channel turn aborted.', 'AbortError'));
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

async function emitGatewayEvent(
  sink: ChannelEventSink,
  event: Parameters<ChannelEventSink['emit']>[0],
  signal?: AbortSignal,
): Promise<void> {
  try {
    if (signal?.aborted) return;
    await abortable(sink.emit(event), signal);
  } catch {
    return;
  }
}
