import type {
  ChannelDestinationV1,
  ChannelKindV1,
} from '@plus-one/contracts';

export interface ChannelEventTarget {
  householdId: string;
  conversationId: string;
  channel: ChannelKindV1;
  destination: ChannelDestinationV1;
}

export type ChannelEvent =
  | { kind: 'typing.start'; target: ChannelEventTarget }
  | { kind: 'typing.stop'; target: ChannelEventTarget }
  | { kind: 'status.update'; target: ChannelEventTarget; statusKey: string; body: string }
  | { kind: 'assistant.commentary'; target: ChannelEventTarget; body: string }
  | { kind: 'tool.started'; target: ChannelEventTarget; toolName: string; preview?: string }
  | { kind: 'tool.finished'; target: ChannelEventTarget; toolName: string; ok: boolean; durationMs: number }
  | { kind: 'final.delivery-started'; target: ChannelEventTarget }
  | { kind: 'final.delivered'; target: ChannelEventTarget; platformMessageId?: string }
  | { kind: 'final.failed'; target: ChannelEventTarget; status: 'blocked' | 'failed' | 'ambiguous'; reason: string };

export interface ChannelEventSink {
  emit(event: ChannelEvent): Promise<void>;
}

export const noopChannelEventSink: ChannelEventSink = {
  emit: async () => undefined,
};

export class DelegatingChannelEventSink implements ChannelEventSink {
  private sink: ChannelEventSink = noopChannelEventSink;

  constructor(initialSink?: ChannelEventSink) {
    if (initialSink !== undefined) this.sink = initialSink;
  }

  setSink(sink: ChannelEventSink): void {
    this.sink = sink;
  }

  async emit(event: ChannelEvent): Promise<void> {
    await this.sink.emit(event);
  }
}

export function targetFromInboundMessage(message: {
  householdId: string;
  conversationId: string;
  channel: ChannelKindV1;
  metadata: Record<string, unknown>;
}): ChannelEventTarget {
  const candidate = message.metadata.destination;
  return {
    householdId: message.householdId,
    conversationId: message.conversationId,
    channel: message.channel,
    destination: typeof candidate === 'object' && candidate !== null
      ? candidate as ChannelDestinationV1
      : {},
  };
}
