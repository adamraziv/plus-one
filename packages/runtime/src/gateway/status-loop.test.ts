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
  it('emits typing immediately and stops it on close', async () => {
    vi.useFakeTimers();
    const emit = vi.fn(async () => undefined);
    const sink: ChannelEventSink = { emit };

    const heartbeat = startGatewayHeartbeat({
      sink,
      target,
      typingEveryMs: 1000,
      statusEveryMs: 5000,
      statuses: ['Still working...'],
    });
    await vi.runOnlyPendingTimersAsync();
    await heartbeat.close();

    expect(emit).toHaveBeenCalledWith({ kind: 'typing.start', target });
    expect(emit).toHaveBeenCalledWith({ kind: 'typing.stop', target });
    vi.useRealTimers();
  });

  it('emits rotating status messages without persisting them', async () => {
    vi.useFakeTimers();
    const emit = vi.fn(async () => undefined);
    const heartbeat = startGatewayHeartbeat({
      sink: { emit },
      target,
      typingEveryMs: 1000,
      statusEveryMs: 2000,
      statuses: ['Checking accounts...', 'Preparing final answer...'],
    });

    await vi.advanceTimersByTimeAsync(2100);
    await vi.advanceTimersByTimeAsync(2100);
    await heartbeat.close();

    expect(emit).toHaveBeenCalledWith({
      kind: 'status.update',
      target,
      statusKey: 'turn',
      body: 'Checking accounts...',
    });
    expect(emit).toHaveBeenCalledWith({
      kind: 'status.update',
      target,
      statusKey: 'turn',
      body: 'Preparing final answer...',
    });
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
      statusEveryMs: 2000,
      statuses: ['Checking accounts...'],
    });

    await vi.advanceTimersByTimeAsync(2100);
    await expect(heartbeat.close()).resolves.toBeUndefined();

    expect(emit).toHaveBeenCalledWith({ kind: 'typing.start', target });
    expect(emit).toHaveBeenCalledWith({ kind: 'typing.stop', target });
    vi.useRealTimers();
  });
});
