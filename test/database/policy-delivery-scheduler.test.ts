import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;

afterEach(async () => {
  await context?.cleanup();
  context = undefined;
});

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const conversationId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const deliveryId = 'delivery_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const jobId = 'job_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const occurrenceId = 'occurrence_01JNZQ4A9B8C7D6E5F4G3H2J1K';

async function seedHousehold(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1, 'USD', 'UTC')`,
    [householdId],
  );
}

async function seedConversation(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO operations.channel_conversations
     (conversation_id, household_id, channel, channel_type, external_conversation_id,
      external_thread_id, destination)
     SELECT $1, id, 'telegram', 'direct', 'telegram-chat-42', '', '{"chatId":"telegram-chat-42"}'
     FROM operations.households WHERE household_id = $2`,
    [conversationId, householdId],
  );
}

describe('policy delivery scheduler persistence', () => {
  it('creates only the required Plan 15 operational relations', async () => {
    context = await createPostgresTestContext('policy_delivery_relations');
    const pool = new Pool({ connectionString: context.migratorUrl });
    try {
      const result = await pool.query<{ relation: string }>(
        `SELECT table_name AS relation FROM information_schema.tables
         WHERE table_schema = 'operations' AND table_name = ANY($1::text[]) ORDER BY table_name`,
        [[
          'channel_conversations',
          'channel_messages',
          'outbound_deliveries',
          'scheduled_job_changes',
          'scheduled_jobs',
          'scheduled_runs',
        ]],
      );

      expect(result.rows.map((row) => row.relation)).toEqual([
        'channel_conversations',
        'channel_messages',
        'outbound_deliveries',
        'scheduled_job_changes',
        'scheduled_jobs',
        'scheduled_runs',
      ]);
    } finally {
      await pool.end();
    }
  });

  it('deduplicates inbound platform messages and outbound delivery keys', async () => {
    context = await createPostgresTestContext('policy_delivery_dedupe');
    const pool = new Pool({ connectionString: context.roleUrls.operations });
    try {
      await seedHousehold(pool);
      await seedConversation(pool);
      await pool.query(
        `INSERT INTO operations.channel_messages
         (conversation_id, household_id, direction, channel, external_message_id,
          body, speaker, attachments, metadata)
         SELECT conversation.id, conversation.household_id, 'inbound', 'telegram', 'telegram-message-1',
                'How did we do?', '{"principalRef":"telegram:user:1"}', '[]', '{}'
         FROM operations.channel_conversations conversation WHERE conversation.conversation_id = $1`,
        [conversationId],
      );
      await expect(pool.query(
        `INSERT INTO operations.channel_messages
         (conversation_id, household_id, direction, channel, external_message_id,
          body, speaker, attachments, metadata)
         SELECT conversation.id, conversation.household_id, 'inbound', 'telegram', 'telegram-message-1',
                'Duplicate', '{"principalRef":"telegram:user:1"}', '[]', '{}'
         FROM operations.channel_conversations conversation WHERE conversation.conversation_id = $1`,
        [conversationId],
      )).rejects.toMatchObject({ code: '23505' });

      await pool.query(
        `INSERT INTO operations.outbound_deliveries
         (delivery_id, household_id, conversation_id, idempotency_key, response_hash,
          status, channel, destination, attempt_count)
         SELECT $1, conversation.household_id, conversation.id, 'delivery-key-1',
                repeat('a', 64), 'pending', 'telegram', '{"chatId":"telegram-chat-42"}', 0
         FROM operations.channel_conversations conversation WHERE conversation.conversation_id = $2`,
        [deliveryId, conversationId],
      );
      await expect(pool.query(
        `INSERT INTO operations.outbound_deliveries
         (delivery_id, household_id, conversation_id, idempotency_key, response_hash,
          status, channel, destination, attempt_count)
         SELECT 'delivery_01JNZQ4A9B8C7D6E5F4G3H2J2K', conversation.household_id, conversation.id,
                'delivery-key-1', repeat('a', 64), 'pending', 'telegram',
                '{"chatId":"telegram-chat-42"}', 0
         FROM operations.channel_conversations conversation WHERE conversation.conversation_id = $1`,
        [conversationId],
      )).rejects.toMatchObject({ code: '23505' });
    } finally {
      await pool.end();
    }
  });

  it('keeps schedule change history append-only', async () => {
    context = await createPostgresTestContext('policy_schedule_history');
    const pool = new Pool({ connectionString: context.roleUrls.operations });
    try {
      await seedHousehold(pool);
      await pool.query(
        `INSERT INTO operations.scheduled_jobs
         (job_id, household_id, version, target_kind, target_team, purpose,
          schedule_kind, schedule_expression, timezone, next_eligible_run_at,
          required_context_schema_name, required_context_schema_version, required_context,
          delivery_behavior, overlap_policy, missed_run_policy, timeout_ms, max_retries, enabled)
         SELECT $1, id, 1, 'orchestrator', NULL, 'Weekly briefing',
                'external', 'weekly-monday-09:00', 'UTC', '2026-06-22T10:00:00.000Z',
                'weekly-briefing-context', 1, '{"lookbackDays":7}',
                '{"mode":"none"}', 'skip', 'run_once', 60000, 2, true
         FROM operations.households WHERE household_id = $2`,
        [jobId, householdId],
      );
      await pool.query(
        `INSERT INTO operations.scheduled_job_changes
         (household_id, job_id, version, rationale, previous_state, next_state)
         SELECT id, $1, 1, 'created from user request', NULL, '{"enabled":true}'
         FROM operations.households WHERE household_id = $2`,
        [jobId, householdId],
      );

      await expect(
        pool.query("UPDATE operations.scheduled_job_changes SET rationale = 'changed'"),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        pool.query('DELETE FROM operations.scheduled_job_changes'),
      ).rejects.toMatchObject({ code: '55000' });
    } finally {
      await pool.end();
    }
  });

  it('persists scheduled run keys and denies non-operations roles', async () => {
    context = await createPostgresTestContext('policy_schedule_permissions');
    const operations = new Pool({ connectionString: context.roleUrls.operations });
    try {
      await seedHousehold(operations);
      await operations.query(
        `INSERT INTO operations.scheduled_jobs
         (job_id, household_id, version, target_kind, target_team, purpose,
          schedule_kind, schedule_expression, timezone, next_eligible_run_at,
          required_context_schema_name, required_context_schema_version, required_context,
          delivery_behavior, overlap_policy, missed_run_policy, timeout_ms, max_retries, enabled)
         SELECT $1, id, 1, 'team_lead', 'query', 'Weekly briefing',
                'external', 'weekly-monday-09:00', 'UTC', '2026-06-22T10:00:00.000Z',
                'weekly-briefing-context', 1, '{"lookbackDays":7}',
                '{"mode":"none"}', 'skip', 'run_once', 60000, 2, true
         FROM operations.households WHERE household_id = $2`,
        [jobId, householdId],
      );
      await operations.query(
        `INSERT INTO operations.scheduled_runs
         (occurrence_id, household_id, job_id, job_version, run_key, scheduled_for,
          status, attempt_count)
         SELECT $1, id, $2, 1, $3, '2026-06-22T10:00:00.000Z', 'claimed', 1
         FROM operations.households WHERE household_id = $4`,
        [occurrenceId, jobId, `${jobId}:1:2026-06-22T10:00:00.000Z`, householdId],
      );
      await expect(operations.query(
        `INSERT INTO operations.scheduled_runs
         (occurrence_id, household_id, job_id, job_version, run_key, scheduled_for,
          status, attempt_count)
         SELECT 'occurrence_01JNZQ4A9B8C7D6E5F4G3H2J2K', id, $1, 1, $2,
                '2026-06-22T10:00:00.000Z', 'claimed', 1
         FROM operations.households WHERE household_id = $3`,
        [jobId, `${jobId}:1:2026-06-22T10:00:00.000Z`, householdId],
      )).rejects.toMatchObject({ code: '23505' });
    } finally {
      await operations.end();
    }

    for (const role of ['query', 'accounting', 'planning'] as const) {
      const pool = new Pool({ connectionString: context.roleUrls[role] });
      await expect(pool.query('SELECT * FROM operations.scheduled_jobs')).rejects.toMatchObject({
        code: '42501',
      });
      await pool.end();
    }
  });
});
