import { describe, expect, it, vi } from 'vitest';
import { startGatewayHeartbeat } from './status-loop.js';
import type { ChannelEventSink, ChannelEventTarget } from './channel-events.js';

const target: ChannelEventTarget = {
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  channel: 'telegram',
  destination: { chatId: 'telegram-chat-42' },
};

describe('gateway heartbeat', () => {
  it('refreshes typing without emitting timer-driven status events', async () => {
    vi.useFakeTimers();
    const emit = vi.fn(async () => undefined);
    const heartbeat = startGatewayHeartbeat({ sink: { emit }, target, typingEveryMs: 1000 });

    await vi.advanceTimersByTimeAsync(2100);
    await heartbeat.close();

    expect(emit).toHaveBeenCalledWith({ kind: 'typing.start', target });
    expect(emit).toHaveBeenCalledWith({ kind: 'typing.stop', target });
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'status.update' }));
    vi.useRealTimers();
  });

  it('emits typing immediately and stops it on close', async () => {
    vi.useFakeTimers();
    const emit = vi.fn(async () => undefined);
    const sink: ChannelEventSink = { emit };

    const heartbeat = startGatewayHeartbeat({
      sink,
      target,
      typingEveryMs: 1000,
    });
    await vi.runOnlyPendingTimersAsync();
    await heartbeat.close();

    expect(emit).toHaveBeenCalledWith({ kind: 'typing.start', target });
    expect(emit).toHaveBeenCalledWith({ kind: 'typing.stop', target });
    vi.useRealTimers();
  });

  it('treats heartbeat transport failures as best-effort', async () => {
    vi.useFakeTimers();
    const emit = vi.fn(async (event: { kind: string }) => {
      if (event.kind !== 'typing.stop') throw new Error('transport unavailable');
    });
    const heartbeat = startGatewayHeartbeat({
      sink: { emit },
      target,
      typingEveryMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(2100);
    await expect(heartbeat.close()).resolves.toBeUndefined();

    expect(emit).toHaveBeenCalledWith({ kind: 'typing.start', target });
    expect(emit).toHaveBeenCalledWith({ kind: 'typing.stop', target });
    vi.useRealTimers();
  });
});
