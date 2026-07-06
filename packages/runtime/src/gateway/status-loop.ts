import type { ChannelEventSink, ChannelEventTarget } from './channel-events.js';

export interface GatewayHeartbeat {
  close(): Promise<void>;
}

export function startGatewayHeartbeat(input: {
  sink: ChannelEventSink;
  target: ChannelEventTarget;
  typingEveryMs: number;
  statusEveryMs: number;
  statuses: readonly string[];
}): GatewayHeartbeat {
  let closed = false;
  let statusIndex = 0;
  const timers = new Set<NodeJS.Timeout>();

  const schedule = (fn: () => Promise<void>, ms: number) => {
    const timer = setTimeout(async () => {
      timers.delete(timer);
      if (closed) return;
      await fn();
      if (!closed) schedule(fn, ms);
    }, ms);
    timers.add(timer);
  };

  void input.sink.emit({ kind: 'typing.start', target: input.target });
  schedule(async () => {
    await input.sink.emit({ kind: 'typing.start', target: input.target });
  }, input.typingEveryMs);
  if (input.statuses.length > 0) {
    schedule(async () => {
      const body = input.statuses[Math.min(statusIndex, input.statuses.length - 1)];
      statusIndex += 1;
      if (body !== undefined) {
        await input.sink.emit({ kind: 'status.update', target: input.target, statusKey: 'turn', body });
      }
    }, input.statusEveryMs);
  }

  return {
    close: async () => {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await input.sink.emit({ kind: 'typing.stop', target: input.target });
    },
  };
}
