import { describe, expect, it, vi } from 'vitest';
import { TelegramChannelEventSink } from '../src/telegram/telegram-channel-event-sink.js';

const target = {
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  channel: 'telegram' as const,
  destination: { chatId: 'telegram-chat-42' },
};

describe('TelegramChannelEventSink', () => {
  it('renders typing through transport capability and ignores stop', async () => {
    const sendTyping = vi.fn(async () => undefined);
    const sink = new TelegramChannelEventSink({ transport: { send: vi.fn(), sendTyping } });

    await sink.emit({ kind: 'typing.start', target });
    await sink.emit({ kind: 'typing.stop', target });

    expect(sendTyping).toHaveBeenCalledWith({ destination: { chatId: 'telegram-chat-42' } });
  });

  it('sends and edits one status message per conversation/status key', async () => {
    const sendOrUpdateStatus = vi
      .fn()
      .mockResolvedValueOnce({ platformMessageId: '501' })
      .mockResolvedValueOnce({ platformMessageId: '501' });
    const sink = new TelegramChannelEventSink({ transport: { send: vi.fn(), sendOrUpdateStatus } });

    await sink.emit({ kind: 'status.update', target, statusKey: 'turn', body: 'Checking...' });
    await sink.emit({ kind: 'status.update', target, statusKey: 'turn', body: 'Preparing final...' });

    expect(sendOrUpdateStatus).toHaveBeenNthCalledWith(1, {
      destination: target.destination,
      body: 'Checking...',
    });
    expect(sendOrUpdateStatus).toHaveBeenNthCalledWith(2, {
      destination: target.destination,
      body: 'Preparing final...',
      statusMessageId: '501',
    });
  });

  it('sends assistant commentary through interim capability when present', async () => {
    const sendInterim = vi.fn(async () => ({ platformMessageId: '600' }));
    const sink = new TelegramChannelEventSink({ transport: { send: vi.fn(), sendInterim } });

    await sink.emit({ kind: 'assistant.commentary', target, body: 'I found matching records.' });

    expect(sendInterim).toHaveBeenCalledWith({
      destination: target.destination,
      body: 'I found matching records.',
      format: 'plain_text',
    });
  });

  it('renders final failure notices through interim capability when present', async () => {
    const sendInterim = vi.fn(async () => ({ platformMessageId: '601' }));
    const sink = new TelegramChannelEventSink({ transport: { send: vi.fn(), sendInterim } });

    await sink.emit({
      kind: 'final.failed',
      target,
      status: 'failed',
      reason: 'orchestrator_failed',
    });

    expect(sendInterim).toHaveBeenCalledWith({
      destination: target.destination,
      body: 'I hit an internal error before I could send the final reply. Please try again.',
      format: 'plain_text',
    });
  });
});
