import { describe, expect, it, vi } from 'vitest';
import { TelegramChannelEventSink } from '../src/telegram/telegram-channel-event-sink.js';

const target = {
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  channel: 'telegram' as const,
  destination: { chatId: 'telegram-chat-42' },
};

describe('TelegramChannelEventSink', () => {
  it('creates status only when delegateTeam starts, updates it for delivery, then deletes it', async () => {
    const sendOrUpdateStatus = vi.fn(async () => ({ platformMessageId: '501' }));
    const deleteMessage = vi.fn(async () => undefined);
    const sink = new TelegramChannelEventSink({ transport: { send: vi.fn(), sendOrUpdateStatus, deleteMessage } });

    await sink.emit({ kind: 'tool.started', target, toolName: 'delegateTeam' });
    await sink.emit({ kind: 'final.delivery-started', target });
    await sink.emit({ kind: 'final.delivered', target, platformMessageId: '700' });

    expect(sendOrUpdateStatus).toHaveBeenNthCalledWith(1, {
      destination: target.destination, body: 'Checking your household records…',
    });
    expect(sendOrUpdateStatus).toHaveBeenNthCalledWith(2, {
      destination: target.destination, body: 'Sending your reply…', statusMessageId: '501',
    });
    expect(deleteMessage).toHaveBeenCalledWith({ destination: target.destination, platformMessageId: '501' });
  });

  it('does not create a status for a direct answer', async () => {
    const sendOrUpdateStatus = vi.fn();
    const sink = new TelegramChannelEventSink({ transport: { send: vi.fn(), sendOrUpdateStatus } });

    await sink.emit({ kind: 'final.delivery-started', target });
    await sink.emit({ kind: 'final.delivered', target, platformMessageId: '700' });

    expect(sendOrUpdateStatus).not.toHaveBeenCalled();
  });

  it('renders typing through transport capability and ignores stop', async () => {
    const sendTyping = vi.fn(async () => undefined);
    const sink = new TelegramChannelEventSink({ transport: { send: vi.fn(), sendTyping } });

    await sink.emit({ kind: 'typing.start', target });
    await sink.emit({ kind: 'typing.stop', target });

    expect(sendTyping).toHaveBeenCalledWith({ destination: { chatId: 'telegram-chat-42' } });
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

  it('explains exhausted transient model failures as retryable provider load', async () => {
    const sendInterim = vi.fn(async () => ({ platformMessageId: '601' }));
    const sink = new TelegramChannelEventSink({ transport: { send: vi.fn(), sendInterim } });

    await sink.emit({
      kind: 'final.failed',
      target,
      status: 'failed',
      reason: 'model_temporarily_unavailable',
    });

    expect(sendInterim).toHaveBeenCalledWith({
      destination: target.destination,
      body: 'The model provider is temporarily busy. Please try again in a moment.',
      format: 'plain_text',
    });
  });

  it('clears delegated status and explains a timeout separately', async () => {
    const sendOrUpdateStatus = vi.fn(async () => ({ platformMessageId: '501' }));
    const deleteMessage = vi.fn(async () => undefined);
    const sendInterim = vi.fn(async () => ({ platformMessageId: '601' }));
    const sink = new TelegramChannelEventSink({ transport: { send: vi.fn(), sendOrUpdateStatus, deleteMessage, sendInterim } });

    await sink.emit({ kind: 'tool.started', target, toolName: 'delegateTeam' });
    await sink.emit({ kind: 'final.failed', target, status: 'failed', reason: 'orchestrator_timed_out' });

    expect(deleteMessage).toHaveBeenCalledWith({ destination: target.destination, platformMessageId: '501' });
    expect(sendInterim).toHaveBeenCalledWith({
      destination: target.destination,
      body: 'This is taking longer than expected. Please try again.',
      format: 'plain_text',
    });
  });

  it('replaces a status when Telegram cannot delete it', async () => {
    const sendOrUpdateStatus = vi.fn(async () => ({ platformMessageId: '501' }));
    const deleteMessage = vi.fn(async () => { throw new Error('delete failed'); });
    const sink = new TelegramChannelEventSink({ transport: { send: vi.fn(), sendOrUpdateStatus, deleteMessage } });

    await sink.emit({ kind: 'tool.started', target, toolName: 'delegateTeam' });
    await expect(sink.emit({ kind: 'final.delivered', target, platformMessageId: '700' })).resolves.toBeUndefined();

    expect(sendOrUpdateStatus).toHaveBeenNthCalledWith(2, {
      destination: target.destination,
      body: 'Reply sent.',
      statusMessageId: '501',
    });
  });
});
