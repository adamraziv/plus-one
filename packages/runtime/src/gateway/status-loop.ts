import type { ChannelEventSink, ChannelEventTarget } from './channel-events.js';

export interface GatewayHeartbeat {
  close(): Promise<void>;
}

export function startGatewayHeartbeat(input: {
  sink: ChannelEventSink;
  target: ChannelEventTarget;
  typingEveryMs: number;
  signal?: AbortSignal;
}): GatewayHeartbeat {
  let closed = false;
  const timers = new Set<NodeJS.Timeout>();

  const emit = async (
    event: Parameters<ChannelEventSink['emit']>[0],
    signal: AbortSignal | undefined = input.signal,
  ) => {
    try {
      if (signal?.aborted) return;
      await abortable(input.sink.emit(event), signal);
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
      void emit({ kind: 'typing.stop', target: input.target }, undefined);
    },
  };
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) throw signal.reason ?? new DOMException('Gateway heartbeat aborted.', 'AbortError');
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Gateway heartbeat aborted.', 'AbortError'));
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
