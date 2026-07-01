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

export type OrchestratorIngressResult =
  | { status: 'duplicate' }
  | { status: 'command-handled'; command: 'new'; body: string; conversationId: string }
  | { status: 'blocked'; processorResult: OutputProcessorResultV1 }
  | { status: 'delivered' | 'failed' | 'ambiguous'; delivery: DeliveryResult; sent: boolean };

export class OrchestratorIngress {
  constructor(private readonly dependencies: {
    inbound: { recordInboundMessage(message: InboundChannelMessageV1): Promise<{ inserted: boolean }> };
    orchestrator: { run(input: { message: InboundChannelMessageV1 }): Promise<OrchestratorFinalResponseV1> };
    delivery: { deliver(response: OrchestratorFinalResponseV1): Promise<DeliveryResult> };
    commands?: { handle(message: InboundChannelMessageV1): Promise<ChannelCommandResultV1 | undefined> };
  }) {}

  async handleInbound(candidate: InboundChannelMessageV1): Promise<OrchestratorIngressResult> {
    const message = InboundChannelMessageSchemaV1.parse(candidate);
    const commandResult = ChannelCommandResultSchemaV1.optional().parse(
      await this.dependencies.commands?.handle(message),
    );
    if (commandResult !== undefined) {
      return {
        status: 'command-handled',
        command: commandResult.command,
        body: commandResult.body,
        conversationId: commandResult.conversationId,
      };
    }

    const recorded = await this.dependencies.inbound.recordInboundMessage(message);
    if (!recorded.inserted) return { status: 'duplicate' };

    const response = OrchestratorFinalResponseSchemaV1.parse(
      await this.dependencies.orchestrator.run({ message }),
    );
    const delivery = await this.dependencies.delivery.deliver(response);
    if (delivery.status === 'blocked') {
      return { status: 'blocked', processorResult: delivery.processorResult };
    }
    return { status: delivery.status, delivery, sent: delivery.sent };
  }
}
