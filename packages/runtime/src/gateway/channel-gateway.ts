import {
  ChannelCommandResultSchemaV1,
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  type ChannelCommandResultV1,
  type InboundChannelMessageV1,
  type OrchestratorFinalResponseV1,
  type OutputProcessorResultV1,
} from '@plus-one/contracts';
import type { DeliveryResult } from '../delivery/final-delivery-handler.js';
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

  constructor(private readonly dependencies: {
    inbound: { recordInboundMessage(message: InboundChannelMessageV1): Promise<{ inserted: boolean }> };
    orchestrator: { run(input: { message: InboundChannelMessageV1 }): Promise<OrchestratorFinalResponseV1> };
    delivery: { deliver(response: OrchestratorFinalResponseV1): Promise<DeliveryResult> };
    commands?: { handle(message: InboundChannelMessageV1): Promise<ChannelCommandResultV1 | undefined> };
    sink?: ChannelEventSink;
    turns?: ActiveTurnRegistry<ChannelGatewayResult>;
    heartbeat?: { typingEveryMs: number; statusEveryMs: number; statuses: readonly string[] };
  }) {
    this.turns = dependencies.turns ?? new ActiveTurnRegistry<ChannelGatewayResult>();
  }

  async handleInbound(candidate: InboundChannelMessageV1): Promise<ChannelGatewayResult> {
    const message = InboundChannelMessageSchemaV1.parse(candidate);
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
    if (!recorded.inserted) return { status: 'duplicate' };

    const submitted = await this.turns.submit(message.conversationId, async () => this.runRecordedTurn(message));
    if (submitted.status === 'started') return submitted.result;
    return submitted;
  }

  async shutdown(): Promise<void> {
    await this.turns.shutdown();
  }

  private async runRecordedTurn(message: InboundChannelMessageV1): Promise<ChannelGatewayResult> {
    const sink = this.dependencies.sink ?? noopChannelEventSink;
    const target = targetFromInboundMessage(message);
    const heartbeat = startGatewayHeartbeat({
      sink,
      target,
      typingEveryMs: this.dependencies.heartbeat?.typingEveryMs ?? 2_000,
      statusEveryMs: this.dependencies.heartbeat?.statusEveryMs ?? 8_000,
      statuses: this.dependencies.heartbeat?.statuses ?? [
        'Checking household records...',
        'Verifying the answer...',
        'Preparing the final reply...',
      ],
    });
    try {
      let response: OrchestratorFinalResponseV1;
      try {
        response = OrchestratorFinalResponseSchemaV1.parse(
          await this.dependencies.orchestrator.run({ message }),
        );
      } catch {
        await emitGatewayEvent(sink, {
          kind: 'final.failed',
          target,
          status: 'failed',
          reason: 'orchestrator_failed',
        });
        return { status: 'failed', error: 'orchestrator_failed', sent: false };
      }
      await emitGatewayEvent(sink, { kind: 'final.delivery-started', target });
      const delivery = await this.dependencies.delivery.deliver(response);
      if (delivery.status === 'blocked') {
        await emitGatewayEvent(sink, {
          kind: 'final.failed',
          target,
          status: 'blocked',
          reason: delivery.processorResult.reason,
        });
        return { status: 'blocked', processorResult: delivery.processorResult };
      }
      if (delivery.status === 'delivered') {
        await emitGatewayEvent(sink, {
          kind: 'final.delivered',
          target,
          ...(delivery.delivery.platformMessageId === undefined
            ? {}
            : { platformMessageId: delivery.delivery.platformMessageId }),
        });
      } else {
        await emitGatewayEvent(sink, {
          kind: 'final.failed',
          target,
          status: delivery.status,
          reason: delivery.delivery.failureCategory ?? delivery.status,
        });
      }
      return { status: delivery.status, delivery, sent: delivery.sent };
    } finally {
      await heartbeat.close();
    }
  }
}

async function emitGatewayEvent(
  sink: ChannelEventSink,
  event: Parameters<ChannelEventSink['emit']>[0],
): Promise<void> {
  try {
    await sink.emit(event);
  } catch {
    return;
  }
}
