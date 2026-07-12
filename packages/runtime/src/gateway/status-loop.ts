import type { ChannelEventSink, ChannelEventTarget } from './channel-events.js';

export interface GatewayHeartbeat {
  close(): Promise<void>;
}

export function startGatewayHeartbeat(input: {
  sink: ChannelEventSink;
  target: ChannelEventTarget;
  typingEveryMs: number;
}): GatewayHeartbeat {
  let closed = false;
  const timers = new Set<NodeJS.Timeout>();

  const emit = async (event: Parameters<ChannelEventSink['emit']>[0]) => {
    try {
      await input.sink.emit(event);
    } catch {
      return;
    }
  };

  const scheduleTyping = () => {
    const timer = setTimeout(async () => {
      timers.delete(timer);
      if (closed) return;
      await emit({ kind: 'typing.start', target: input.target });
      if (!closed) scheduleTyping();
    }, input.typingEveryMs);
    timers.add(timer);
  };

  void emit({ kind: 'typing.start', target: input.target });
  scheduleTyping();

  return {
    close: async () => {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await emit({ kind: 'typing.stop', target: input.target });
    },
  };
}
