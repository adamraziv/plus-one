import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresDeliveryRepository } from '@plus-one/database';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;

afterEach(async () => {
  await context?.cleanup();
  context = undefined;
});

describe('PostgresDeliveryRepository channel conversation lanes', () => {
  it('starts a fresh active conversation for a Telegram lane', async () => {
    context = await createPostgresTestContext('repository_channel_conversation_lanes');
    const pool = new Pool({ connectionString: context.roleUrls.operations });
    const repository = new PostgresDeliveryRepository(pool);

    try {
      await pool.query(
        `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
         VALUES ($1, 'USD', 'UTC')`,
        ['hh_01JNZQ4A9B8C7D6E5F4G3H2J1K'],
      );

      const first = await repository.startNewConversation({
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        channel: 'telegram',
        channelType: 'direct',
        externalConversationId: 'telegram-chat-42',
        externalThreadId: '',
        destination: { chatId: 'telegram-chat-42' },
      });
      const second = await repository.startNewConversation({
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J2K',
        channel: 'telegram',
        channelType: 'direct',
        externalConversationId: 'telegram-chat-42',
        externalThreadId: '',
        destination: { chatId: 'telegram-chat-42' },
      });

      expect(first.conversationId).toBe('conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K');
      expect(second.conversationId).toBe('conversation_01JNZQ4A9B8C7D6E5F4G3H2J2K');

      await expect(repository.resolveActiveConversation({
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        channel: 'telegram',
        externalConversationId: 'telegram-chat-42',
        externalThreadId: '',
      })).resolves.toMatchObject({
        conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J2K',
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        channel: 'telegram',
        channelType: 'direct',
        externalConversationId: 'telegram-chat-42',
        destination: { chatId: 'telegram-chat-42' },
      });
    } finally {
      await pool.end();
    }
  });
});
