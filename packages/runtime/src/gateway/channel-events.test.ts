import { describe, expect, it, vi } from 'vitest';
import {
  DelegatingChannelEventSink,
  noopChannelEventSink,
  targetFromInboundMessage,
  type ChannelEvent,
  type ChannelEventSink,
} from './channel-events.js';

const inbound = {
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  channel: 'telegram' as const,
  metadata: { destination: { chatId: 'telegram-chat-42' } },
};

describe('channel gateway events', () => {
  it('keeps transport events destination-aware and non-durable', async () => {
    const events: ChannelEvent[] = [];
    const sink: ChannelEventSink = {
      emit: vi.fn(async (event) => {
        events.push(event);
      }),
    };
    const target = targetFromInboundMessage(inbound);

    await sink.emit({ kind: 'typing.start', target });
    await sink.emit({ kind: 'status.update', target, statusKey: 'turn', body: 'Checking the ledger...' });
    await sink.emit({ kind: 'assistant.commentary', target, body: 'I found the account list.' });
    await sink.emit({ kind: 'typing.stop', target });

    expect(events.map((event) => event.kind)).toEqual([
      'typing.start',
      'status.update',
      'assistant.commentary',
      'typing.stop',
    ]);
    expect(events[0]?.target.destination).toEqual({ chatId: 'telegram-chat-42' });
  });

  it('uses an empty destination when inbound metadata has no destination object', () => {
    expect(targetFromInboundMessage({ ...inbound, metadata: {} }).destination).toEqual({});
  });

  it('provides a no-op sink for API routes and tests', async () => {
    await expect(noopChannelEventSink.emit({
      kind: 'typing.start',
      target: targetFromInboundMessage(inbound),
    })).resolves.toBeUndefined();
  });

  it('delegates to a concrete sink after bootstrap installs one', async () => {
    const received: ChannelEvent[] = [];
    const sink = new DelegatingChannelEventSink();

    await sink.emit({ kind: 'typing.start', target: targetFromInboundMessage(inbound) });
    sink.setSink({ emit: async (event) => { received.push(event); } });
    await sink.emit({ kind: 'typing.start', target: targetFromInboundMessage(inbound) });

    expect(received).toHaveLength(1);
  });
});
