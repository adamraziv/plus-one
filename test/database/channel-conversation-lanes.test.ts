import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;

afterEach(async () => {
  await context?.cleanup();
  context = undefined;
});

describe('channel conversation active lanes', () => {
  it('points a stable channel lane at the active conversation', async () => {
    context = await createPostgresTestContext('channel_conversation_active_lanes');
    const pool = new Pool({ connectionString: context.roleUrls.operations });

    try {
      await pool.query(
        `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
         VALUES ($1, 'USD', 'UTC')`,
        ['hh_01JNZQ4A9B8C7D6E5F4G3H2J1K'],
      );

      for (const conversationId of [
        'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        'conversation_01JNZQ4A9B8C7D6E5F4G3H2J2K',
      ]) {
        await pool.query(
          `INSERT INTO operations.channel_conversations
           (conversation_id, household_id, channel, channel_type, external_conversation_id,
            external_thread_id, destination)
           SELECT $1, household.id, 'telegram', 'direct', 'telegram-chat-42', '', $2
           FROM operations.households household
           WHERE household.household_id = $3`,
          [
            conversationId,
            JSON.stringify({ chatId: 'telegram-chat-42' }),
            'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
          ],
        );
      }

      await pool.query(
        `INSERT INTO operations.channel_conversation_active_lanes
         (household_id, channel, external_conversation_id, external_thread_id, active_conversation_id)
         SELECT household.id, 'telegram', 'telegram-chat-42', '', conversation.id
         FROM operations.households household
         JOIN operations.channel_conversations conversation
           ON conversation.household_id = household.id
          AND conversation.conversation_id = $1
         WHERE household.household_id = $2`,
        ['conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K', 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K'],
      );

      await pool.query(
        `UPDATE operations.channel_conversation_active_lanes lane
         SET active_conversation_id = conversation.id, updated_at = clock_timestamp()
         FROM operations.channel_conversations conversation
         JOIN operations.households household ON household.id = conversation.household_id
         WHERE lane.household_id = household.id
           AND household.household_id = $1
           AND lane.channel = 'telegram'
           AND lane.external_conversation_id = 'telegram-chat-42'
           AND lane.external_thread_id = ''
           AND conversation.conversation_id = $2`,
        ['hh_01JNZQ4A9B8C7D6E5F4G3H2J1K', 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J2K'],
      );

      const result = await pool.query<{ conversation_id: string }>(
        `SELECT conversation.conversation_id
         FROM operations.channel_conversation_active_lanes lane
         JOIN operations.channel_conversations conversation ON conversation.id = lane.active_conversation_id
         JOIN operations.households household ON household.id = lane.household_id
         WHERE household.household_id = $1
           AND lane.channel = 'telegram'
           AND lane.external_conversation_id = 'telegram-chat-42'
           AND lane.external_thread_id = ''`,
        ['hh_01JNZQ4A9B8C7D6E5F4G3H2J1K'],
      );

      expect(result.rows).toEqual([{ conversation_id: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J2K' }]);
    } finally {
      await pool.end();
    }
  });
});
