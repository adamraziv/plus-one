import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import {
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  TeamResultEnvelopeSchemaV1,
  type ChannelKindV1,
} from '@plus-one/contracts';
import { PostgresDeliveryRepository, PostgresSchedulerRepository } from '@plus-one/database';
import {
  ApplicationScheduler,
  FinalDeliveryHandler,
  OrchestratorIngress,
  type TransportSendInput,
} from '@plus-one/runtime';
import { createPostgresTestContext } from '../helpers/postgres.js';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const telegramConversationId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const slackConversationId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J2K';
const deliveryId = 'delivery_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const scheduledDeliveryId = 'delivery_01JNZQ4A9B8C7D6E5F4G3H2J2K';
const jobId = 'job_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const occurrenceId = 'occurrence_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const activeOccurrenceId = 'occurrence_01JNZQ4A9B8C7D6E5F4G3H2J2K';
const now = '2026-06-22T10:00:00.000Z';

async function withOperationsPool(
  label: string,
  run: (pool: Pool) => Promise<void>,
): Promise<void> {
  const context = await createPostgresTestContext(label);
  const pool = new Pool({ connectionString: context.roleUrls.operations });
  try {
    await run(pool);
  } finally {
    await pool.end();
    await context.cleanup();
  }
}

async function seedHousehold(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1, 'USD', 'UTC')`,
    [householdId],
  );
}

async function seedConversation(
  pool: Pool,
  input: {
    conversationId: string;
    channel: ChannelKindV1;
    channelType: 'direct' | 'channel';
    externalConversationId: string;
    externalThreadId?: string;
    destination: Record<string, unknown>;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO operations.channel_conversations
     (conversation_id, household_id, channel, channel_type, external_conversation_id,
      external_thread_id, destination)
     SELECT $1, id, $3, $4, $5, $6, $7::jsonb
     FROM operations.households WHERE household_id = $2`,
    [
      input.conversationId,
      householdId,
      input.channel,
      input.channelType,
      input.externalConversationId,
      input.externalThreadId ?? '',
      JSON.stringify(input.destination),
    ],
  );
}

async function seedTelegramConversation(pool: Pool): Promise<void> {
  await seedConversation(pool, {
    conversationId: telegramConversationId,
    channel: 'telegram',
    channelType: 'direct',
    externalConversationId: 'telegram-chat-42',
    destination: { chatId: 'telegram-chat-42' },
  });
}

async function seedSlackConversation(pool: Pool): Promise<void> {
  await seedConversation(pool, {
    conversationId: slackConversationId,
    channel: 'slack',
    channelType: 'channel',
    externalConversationId: 'slack-channel-42',
    externalThreadId: 'slack-thread-1',
    destination: { channelId: 'slack-channel-42', threadTs: 'slack-thread-1' },
  });
}

async function seedScheduledJob(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO operations.scheduled_jobs
     (job_id, household_id, version, target_kind, target_team, purpose,
      schedule_kind, schedule_expression, timezone, next_eligible_run_at,
      required_context_schema_name, required_context_schema_version, required_context,
      delivery_behavior, overlap_policy, missed_run_policy, timeout_ms, max_retries, enabled)
     SELECT $1, id, 1, 'team_lead', 'query', 'Weekly briefing',
            'external', 'weekly-monday-10:00', 'UTC', $2,
            'weekly-briefing-context', 1, '{"lookbackDays":7}'::jsonb,
            '{"mode":"deliver_final_response","channel":"telegram","destination":{"chatId":"telegram-chat-42"}}'::jsonb,
            'skip', 'run_once', 60000, 0, true
     FROM operations.households WHERE household_id = $3`,
    [jobId, now, householdId],
  );
}

async function countRows(
  pool: Pool,
  table: 'channel_messages' | 'outbound_deliveries' | 'scheduled_runs',
): Promise<number> {
  const result = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM operations.${table}`);
  return result.rows[0]?.count ?? 0;
}

function inboundMessage(channel: ChannelKindV1, conversationId: string, externalMessageId: string) {
  return InboundChannelMessageSchemaV1.parse({
    schemaName: 'inbound-channel-message',
    schemaVersion: 1,
    conversationId,
    householdId,
    channel,
    externalMessageId,
    receivedAt: now,
    speaker: { principalRef: `${channel}:user:1` },
    body: 'How did we do?',
    attachments: [],
    metadata: { claimedIdentity: 'ignored-by-acceptance-boundary' },
  });
}

function finalResponse(overrides: Partial<{
  responseId: string;
  conversationId: string;
  body: string;
  disclaimer: string;
  delivery: { channel: ChannelKindV1; destination: Record<string, unknown>; format: 'plain_text' | 'mrkdwn' };
  responseHash: string;
}> = {}) {
  const delivery = overrides.delivery ?? {
    channel: 'telegram' as const,
    destination: { chatId: 'telegram-chat-42' },
    format: 'plain_text' as const,
  };
  return OrchestratorFinalResponseSchemaV1.parse({
    schemaName: 'orchestrator-final-response',
    schemaVersion: 1,
    responseId: overrides.responseId ?? 'response-2026-06-22-001',
    householdId,
    conversationId: overrides.conversationId ?? telegramConversationId,
    body: overrides.body ?? 'You were under budget. Plus One is an AI assistant, not a licensed financial professional.',
    policyBoundary: 'personalized_finance',
    citations: [{ label: 'June budget variance', artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K' }],
    assumptions: ['June transactions are fully imported.'],
    freshness: ['Budget projection refreshed 2026-06-22.'],
    disclaimer: overrides.disclaimer ?? 'Plus One is an AI assistant, not a licensed financial professional.',
    unsupportedCapabilities: [],
    recommendationActions: ['Move $50 from dining to groceries next month.'],
    delivery,
    responseHash: overrides.responseHash ?? 'a'.repeat(64),
    createdAt: now,
  });
}

function teamResult() {
  const artifactId = 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K';
  const artifactHash = 'd'.repeat(64);
  return TeamResultEnvelopeSchemaV1.parse({
    schemaName: 'team-result',
    schemaVersion: 1,
    householdId,
    taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    team: 'query',
    status: 'verified',
    claims: [{
      claimId: 'weekly-briefing-claim-1',
      text: 'The household was under budget for the checked period.',
      evidenceArtifactIds: [artifactId],
      checkedMakerArtifactIds: [artifactId],
    }],
    assumptions: [],
    uncertainty: [],
    freshness: [],
    coverage: [],
    makerArtifacts: [{
      artifactId,
      householdId,
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      artifactType: 'maker_output',
      schema: { schemaName: 'weekly-briefing', schemaVersion: 1 },
      canonicalizationVersion: 'rfc8785-v1',
      hashAlgorithm: 'sha256',
      artifactHash,
      payload: { summary: 'under budget' },
      createdAt: now,
    }],
    checkerVerdicts: [{
      verdict: 'accepted',
      coveredArtifactId: artifactId,
      coveredArtifactHash: artifactHash,
      findings: [],
    }],
    selectedSkill: {
      skillName: 'scheduled-brief',
      skillVersion: 1,
      contentHash: 'b'.repeat(64),
    },
    strategyName: 'single-maker-checker',
    stopCondition: { code: 'scheduled-brief', description: 'Produce a scheduled briefing.' },
    completionReason: 'Ready for orchestrator reconciliation.',
    outstanding: [],
  });
}

describe('Plus One acceptance harness', () => {
  it('routes inbound Telegram through one orchestrator and deduplicates platform retries', async () => {
    await withOperationsPool('acceptance_inbound_delivery', async (pool) => {
      await seedHousehold(pool);
      await seedTelegramConversation(pool);
      const repository = new PostgresDeliveryRepository(pool);
      const sent: TransportSendInput[] = [];
      const send = vi.fn(async (input: TransportSendInput) => {
        sent.push(input);
        return { platformMessageId: 'telegram-platform-123' };
      });
      const orchestrator = vi.fn(async () => finalResponse());
      const delivery = new FinalDeliveryHandler({
        repository,
        transports: { telegram: { send }, slack: { send: vi.fn() } },
        ids: { nextDeliveryId: () => deliveryId },
      });
      const ingress = new OrchestratorIngress({
        inbound: repository,
        orchestrator: { run: orchestrator },
        delivery,
      });
      const message = inboundMessage('telegram', telegramConversationId, 'telegram-message-1');

      await expect(ingress.handleInbound(message)).resolves.toMatchObject({ status: 'delivered', sent: true });
      await expect(ingress.handleInbound(message)).resolves.toEqual({ status: 'duplicate' });

      expect(orchestrator).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(sent[0]).toMatchObject({ body: finalResponse().body, destination: { chatId: 'telegram-chat-42' } });
      await expect(countRows(pool, 'channel_messages')).resolves.toBe(1);
      await expect(countRows(pool, 'outbound_deliveries')).resolves.toBe(1);
    });
  });

  it('blocks unsafe Slack final output before reserving delivery or sending transport', async () => {
    await withOperationsPool('acceptance_processor_block', async (pool) => {
      await seedHousehold(pool);
      await seedSlackConversation(pool);
      const repository = new PostgresDeliveryRepository(pool);
      const send = vi.fn();
      const delivery = new FinalDeliveryHandler({
        repository,
        transports: { telegram: { send: vi.fn() }, slack: { send } },
        ids: { nextDeliveryId: () => deliveryId },
      });
      const ingress = new OrchestratorIngress({
        inbound: repository,
        orchestrator: {
          run: vi.fn(async () => finalResponse({
            responseId: 'response-2026-06-22-002',
            conversationId: slackConversationId,
            disclaimer: 'Review with a professional.',
            delivery: {
              channel: 'slack',
              destination: { channelId: 'slack-channel-42', threadTs: 'slack-thread-1' },
              format: 'mrkdwn',
            },
            responseHash: 'b'.repeat(64),
          })),
        },
        delivery,
      });

      await expect(ingress.handleInbound(inboundMessage('slack', slackConversationId, 'slack-message-1')))
        .resolves.toMatchObject({ status: 'blocked' });
      expect(send).not.toHaveBeenCalled();
      await expect(countRows(pool, 'channel_messages')).resolves.toBe(1);
      await expect(countRows(pool, 'outbound_deliveries')).resolves.toBe(0);
    });
  });

  it('routes scheduled team-lead results through orchestrator reconciliation and records delivery success', async () => {
    await withOperationsPool('acceptance_scheduler_delivery', async (pool) => {
      await seedHousehold(pool);
      await seedTelegramConversation(pool);
      await seedScheduledJob(pool);
      const deliveryRepository = new PostgresDeliveryRepository(pool);
      const schedulerRepository = new PostgresSchedulerRepository(pool, {
        nextOccurrenceId: () => occurrenceId,
      });
      const teamLead = vi.fn(async () => teamResult());
      const reconcile = vi.fn(async () => finalResponse({
        responseId: 'response-2026-06-22-003',
        responseHash: 'c'.repeat(64),
      }));
      const send = vi.fn(async () => ({ platformMessageId: 'telegram-platform-456' }));
      const scheduler = new ApplicationScheduler({
        repository: schedulerRepository,
        targets: { orchestrator: vi.fn(), teamLead, orchestratorReconciler: { reconcile } },
        delivery: new FinalDeliveryHandler({
          repository: deliveryRepository,
          transports: { telegram: { send }, slack: { send: vi.fn() } },
          ids: { nextDeliveryId: () => scheduledDeliveryId },
        }),
      });

      await expect(scheduler.dispatchDue(now, 5)).resolves.toHaveLength(1);

      expect(teamLead.mock.invocationCallOrder[0]).toBeLessThan(reconcile.mock.invocationCallOrder[0] ?? 0);
      expect(reconcile.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0] ?? 0);
      await expect(countRows(pool, 'scheduled_runs')).resolves.toBe(1);
      await expect(countRows(pool, 'outbound_deliveries')).resolves.toBe(1);
      const run = await pool.query<{ status: string; delivery_id: string | null }>(
        'SELECT status, delivery_id FROM operations.scheduled_runs WHERE occurrence_id = $1',
        [occurrenceId],
      );
      expect(run.rows[0]).toEqual({ status: 'succeeded', delivery_id: scheduledDeliveryId });
    });
  });

  it('does not dispatch a skip-overlap scheduled job while an active run exists', async () => {
    await withOperationsPool('acceptance_scheduler_overlap', async (pool) => {
      await seedHousehold(pool);
      await seedScheduledJob(pool);
      await pool.query(
        `INSERT INTO operations.scheduled_runs
         (occurrence_id, household_id, job_id, job_version, run_key, scheduled_for,
          status, attempt_count)
         SELECT $1, id, $2, 1, $3, '2026-06-22T09:00:00.000Z', 'claimed', 1
         FROM operations.households WHERE household_id = $4`,
        [activeOccurrenceId, jobId, `${jobId}:1:2026-06-22T09:00:00.000Z`, householdId],
      );
      const scheduler = new ApplicationScheduler({
        repository: new PostgresSchedulerRepository(pool, { nextOccurrenceId: () => occurrenceId }),
        targets: {
          orchestrator: vi.fn(),
          teamLead: vi.fn(),
          orchestratorReconciler: { reconcile: vi.fn() },
        },
        delivery: { deliver: vi.fn() },
      });

      await expect(scheduler.dispatchDue(now, 5)).resolves.toEqual([]);
    });
  });

  it('keeps deferred subsystem implementations absent', () => {
    expect([
      'packages/auth',
      'packages/authorization',
      'packages/tracing',
      'packages/evaluation',
      'packages/tax',
      'packages/insurance',
      'packages/cloud',
      'packages/external-actions',
      'apps/auth',
      'apps/cloud',
    ].filter((path) => existsSync(resolve(path)))).toEqual([]);
  });
});
