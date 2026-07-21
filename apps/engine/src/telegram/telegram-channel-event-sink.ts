import type { ChannelEvent, ChannelEventSink, ChannelEventTarget, TransportAdapter } from '@plus-one/runtime';

export class TelegramChannelEventSink implements ChannelEventSink {
  private readonly statusMessages = new Map<string, string>();
  private readonly commentaryTurns = new Set<string>();

  constructor(private readonly input: { transport: TransportAdapter }) {}

  async emit(event: ChannelEvent): Promise<void> {
    if (event.target.channel !== 'telegram') return;
    if (event.kind === 'typing.start') {
      await this.input.transport.sendTyping?.({ destination: event.target.destination });
      return;
    }
    if (event.kind === 'typing.stop') return;
    if (event.kind === 'tool.started' && event.toolName === 'delegateTeam') {
      if (this.commentaryTurns.has(statusKey(event.target, 'turn'))) return;
      await this.sendStatus(event.target, 'turn', 'Checking your household records…');
      return;
    }
    if (event.kind === 'final.delivery-started') {
      await this.updateExistingStatus(event.target, 'Sending your reply…');
      return;
    }
    if (event.kind === 'final.delivered') {
      this.commentaryTurns.delete(statusKey(event.target, 'turn'));
      await this.clearStatus(event.target, 'Reply sent.');
      return;
    }
    if (event.kind === 'assistant.commentary') {
      if (this.input.transport.sendInterim === undefined) return;
      await this.input.transport.sendInterim({
        destination: event.target.destination,
        body: event.body,
        format: 'plain_text',
      });
      this.commentaryTurns.add(statusKey(event.target, 'turn'));
      return;
    }
    if (event.kind === 'final.failed') {
      this.commentaryTurns.delete(statusKey(event.target, 'turn'));
      const body = failureMessage(event.reason);
      await this.clearStatus(event.target, body);
      await this.input.transport.sendInterim?.({
        destination: event.target.destination,
        body,
        format: 'plain_text',
      });
    }
  }

  private async sendStatus(target: ChannelEventTarget, keyName: string, body: string): Promise<void> {
    if (this.input.transport.sendOrUpdateStatus === undefined) return;
    const key = statusKey(target, keyName);
    const statusMessageId = this.statusMessages.get(key);
    const result = await this.input.transport.sendOrUpdateStatus({
      destination: target.destination,
      body,
      ...(statusMessageId === undefined ? {} : { statusMessageId }),
    });
    this.statusMessages.set(key, result.platformMessageId);
  }

  private async updateExistingStatus(target: ChannelEventTarget, body: string): Promise<void> {
    if (this.input.transport.sendOrUpdateStatus === undefined) return;
    const key = statusKey(target, 'turn');
    const statusMessageId = this.statusMessages.get(key);
    if (statusMessageId === undefined) return;
    const result = await this.input.transport.sendOrUpdateStatus({
      destination: target.destination,
      body,
      statusMessageId,
    });
    this.statusMessages.set(key, result.platformMessageId);
  }

  private async clearStatus(target: ChannelEventTarget, replacementBody: string): Promise<void> {
    const key = statusKey(target, 'turn');
    const statusMessageId = this.statusMessages.get(key);
    this.statusMessages.delete(key);
    if (statusMessageId === undefined) return;
    if (this.input.transport.deleteMessage !== undefined) {
      try {
        await this.input.transport.deleteMessage({
          destination: target.destination,
          platformMessageId: statusMessageId,
        });
        return;
      } catch {
        // Fall through to an in-place terminal status when deletion fails.
      }
    }
    if (this.input.transport.sendOrUpdateStatus === undefined) return;
    try {
      await this.input.transport.sendOrUpdateStatus({
        destination: target.destination,
        body: replacementBody,
        statusMessageId,
      });
    } catch {
      return;
    }
  }
}

function failureMessage(reason: string): string {
  if (reason === 'orchestrator_timed_out') {
    return 'This is taking longer than expected. Please try again.';
  }
  if (reason === 'model_temporarily_unavailable') {
    return 'The model provider is temporarily busy. Please try again in a moment.';
  }
  return 'I hit an internal error before I could send the final reply. Please try again.';
}

function statusKey(target: ChannelEventTarget, key: string): string {
  return `${target.conversationId}:${key}`;
}
