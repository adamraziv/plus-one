import { describe, expect, it, vi } from 'vitest';
import { InboundChannelMessageSchemaV1 } from '@plus-one/contracts';
import { normalizeAccountingLeadRequest } from '../src/team-runtime.js';

const message = InboundChannelMessageSchemaV1.parse({
  schemaName: 'inbound-channel-message',
  schemaVersion: 1,
  conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  channel: 'telegram',
  externalMessageId: 'telegram-message-1',
  receivedAt: '2026-06-24T12:00:00.000Z',
  speaker: { principalRef: 'telegram:user:1' },
  body: 'add $10 of buying a burger',
  attachments: [],
  metadata: { destination: { chatId: 'telegram-chat-42' } },
});

describe('normalizeAccountingLeadRequest', () => {
  it('canonicalizes transaction capture requests from inbound context', async () => {
    const pools = {
      accounting: {
        query: vi.fn(async () => ({ rows: [{ book_id: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' }] })),
      },
    } as never;

    const normalized = await normalizeAccountingLeadRequest(pools, message, {
      schemaName: 'accounting-lead-request',
      schemaVersion: 1,
      intent: 'transaction_capture',
      request: {
        description: 'buying a burger',
        amount: 10,
        currency: 'USD',
      },
    });

    expect(normalized).toMatchObject({
      schemaName: 'accounting-lead-request',
      schemaVersion: 1,
      intent: 'transaction_capture',
      request: {
        schemaName: 'transaction-capture-request',
        schemaVersion: 1,
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        explicitInstruction: true,
        instruction: 'add $10 of buying a burger',
        known: {
          amount: '10.00',
          currency: 'USD',
        },
      },
    });
  });
});
