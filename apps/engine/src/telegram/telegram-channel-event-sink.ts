import type { ChannelEvent, ChannelEventSink, TransportAdapter } from '@plus-one/runtime';

export class TelegramChannelEventSink implements ChannelEventSink {
  private readonly statusMessages = new Map<string, string>();

  constructor(private readonly input: { transport: TransportAdapter }) {}

  async emit(event: ChannelEvent): Promise<void> {
    if (event.target.channel !== 'telegram') return;
    if (event.kind === 'typing.start') {
      await this.input.transport.sendTyping?.({ destination: event.target.destination });
      return;
    }
    if (event.kind === 'typing.stop') return;
    if (event.kind === 'status.update') {
      await this.sendStatus(event);
      return;
    }
    if (event.kind === 'assistant.commentary') {
      await this.input.transport.sendInterim?.({
        destination: event.target.destination,
        body: event.body,
        format: 'plain_text',
      });
    }
  }

  private async sendStatus(event: Extract<ChannelEvent, { kind: 'status.update' }>): Promise<void> {
    if (this.input.transport.sendOrUpdateStatus === undefined) return;
    const key = `${event.target.conversationId}:${event.statusKey}`;
    const statusMessageId = this.statusMessages.get(key);
    const result = await this.input.transport.sendOrUpdateStatus({
      destination: event.target.destination,
      body: event.body,
      ...(statusMessageId === undefined ? {} : { statusMessageId }),
    });
    this.statusMessages.set(key, result.platformMessageId);
  }
}
