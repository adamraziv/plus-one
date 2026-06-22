import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresDeliveryRepository, PostgresSchedulerRepository } from '@plus-one/database';
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
const now = '2026-06-22T10:00:00.000Z';

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

async function seedJob(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO operations.scheduled_jobs
     (job_id, household_id, version, target_kind, target_team, purpose,
      schedule_kind, schedule_expression, timezone, next_eligible_run_at,
      required_context_schema_name, required_context_schema_version, required_context,
      delivery_behavior, overlap_policy, missed_run_policy, timeout_ms, max_retries, enabled)
     SELECT $1, id, 1, 'team_lead', 'query', 'Weekly briefing',
            'external', 'weekly-monday-10:00', 'UTC', $2,
            'weekly-briefing-context', 1, '{"lookbackDays":7}',
            '{"mode":"none"}', 'skip', 'run_once', 60000, 2, true
     FROM operations.households WHERE household_id = $3`,
    [jobId, now, householdId],
  );
}

function finalResponse() {
  return {
    schemaName: 'orchestrator-final-response',
    schemaVersion: 1,
    responseId: 'response-2026-06-22-001',
    householdId,
    conversationId,
    body: 'You were under budget. Plus One is an AI assistant, not a licensed financial professional.',
    policyBoundary: 'personalized_finance',
    citations: [{ label: 'June budget variance', artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K' }],
    assumptions: ['June transactions are fully imported.'],
    freshness: ['Budget projection refreshed 2026-06-22.'],
    disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
    unsupportedCapabilities: [],
    recommendationActions: ['Move $50 from dining to groceries next month.'],
    delivery: { channel: 'telegram', destination: { chatId: 'telegram-chat-42' }, format: 'plain_text' },
    responseHash: 'a'.repeat(64),
    createdAt: now,
  } as const;
}

describe('delivery and scheduler repositories', () => {
  it('deduplicates inbound messages and delivery reservations', async () => {
    context = await createPostgresTestContext('delivery_repository');
    const pool = new Pool({ connectionString: context.roleUrls.operations });
    try {
      await seedHousehold(pool);
      await seedConversation(pool);
      const repository = new PostgresDeliveryRepository(pool);

      await expect(repository.recordInboundMessage({
        schemaName: 'inbound-channel-message',
        schemaVersion: 1,
        conversationId,
        householdId,
        channel: 'telegram',
        externalMessageId: 'telegram-message-1',
        receivedAt: now,
        speaker: { principalRef: 'telegram:user:1' },
        body: 'How did we do?',
        attachments: [],
        metadata: {},
      })).resolves.toEqual({ inserted: true });
      await expect(repository.recordInboundMessage({
        schemaName: 'inbound-channel-message',
        schemaVersion: 1,
        conversationId,
        householdId,
        channel: 'telegram',
        externalMessageId: 'telegram-message-1',
        receivedAt: now,
        speaker: { principalRef: 'telegram:user:1' },
        body: 'How did we do?',
        attachments: [],
        metadata: {},
      })).resolves.toEqual({ inserted: false });

      const first = await repository.reserveDelivery({
        deliveryId,
        idempotencyKey: 'delivery-key-1',
        response: finalResponse(),
      });
      const replay = await repository.reserveDelivery({
        deliveryId: 'delivery_01JNZQ4A9B8C7D6E5F4G3H2J2K',
        idempotencyKey: 'delivery-key-1',
        response: finalResponse(),
      });
      expect(replay.deliveryId).toBe(first.deliveryId);
      expect(replay.status).toBe('pending');

      const delivered = await repository.markDelivered(householdId, deliveryId, 'telegram-platform-123');
      expect(delivered).toMatchObject({ status: 'delivered', platformMessageId: 'telegram-platform-123' });
      const afterDeliveredReplay = await repository.reserveDelivery({
        deliveryId: 'delivery_01JNZQ4A9B8C7D6E5F4G3H2J3K',
        idempotencyKey: 'delivery-key-1',
        response: finalResponse(),
      });
      expect(afterDeliveredReplay).toMatchObject({ deliveryId, status: 'delivered' });
    } finally {
      await pool.end();
    }
  });

  it('claims a due scheduled run once and records terminal status', async () => {
    context = await createPostgresTestContext('scheduler_repository');
    const pool = new Pool({ connectionString: context.roleUrls.operations });
    try {
      await seedHousehold(pool);
      await seedJob(pool);
      const repository = new PostgresSchedulerRepository(pool, {
        nextOccurrenceId: () => occurrenceId,
      });

      const claimed = await repository.claimDueRuns(now, 5);
      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({
        occurrenceId,
        jobId,
        jobVersion: 1,
        runKey: `${jobId}:1:${now}`,
        target: { kind: 'team_lead', team: 'query' },
      });
      await expect(repository.claimDueRuns(now, 5)).resolves.toEqual([]);

      await expect(repository.completeRun({
        householdId,
        occurrenceId,
        status: 'succeeded',
      })).resolves.toMatchObject({ status: 'succeeded', occurrenceId });
    } finally {
      await pool.end();
    }
  });
});
