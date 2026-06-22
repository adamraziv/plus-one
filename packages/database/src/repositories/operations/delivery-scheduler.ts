import {
  DeliveryRecordSchemaV1,
  DeliveryIdSchema,
  HouseholdIdSchema,
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  PlusOneError,
  ScheduledRunSchemaV1,
  type DeliveryRecordV1,
  type ScheduledRunV1,
} from '@plus-one/contracts';
import type { Pool } from 'pg';

interface DeliveryRow {
  delivery_id: string;
  household_id: string;
  conversation_id: string;
  channel: 'telegram' | 'slack';
  idempotency_key: string;
  response_hash: string;
  status: 'pending' | 'sending' | 'delivered' | 'failed' | 'ambiguous';
  destination: Record<string, unknown>;
  platform_message_id: string | null;
  attempt_count: number;
  failure_category: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ScheduledRunRow {
  occurrence_id: string;
  job_id: string;
  job_version: number;
  household_id: string;
  run_key: string;
  scheduled_for: Date;
  status: 'claimed' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'skipped';
  attempt_count: number;
  task_id: string | null;
  delivery_id: string | null;
  failure_category: string | null;
  created_at: Date;
  updated_at: Date;
}

interface DueJobRow {
  database_id: string;
  job_id: string;
  household_id: string;
  version: number;
  target_kind: 'orchestrator' | 'team_lead';
  target_team: string | null;
  next_eligible_run_at: Date;
  timeout_ms: number;
  max_retries: number;
  required_context: unknown;
  delivery_behavior: unknown;
  overlap_policy: 'skip' | 'allow';
  missed_run_policy: 'skip' | 'run_once' | 'bounded_catch_up';
}

export interface ReservedDeliveryInput {
  deliveryId: string;
  idempotencyKey: string;
  response: unknown;
}

export interface ScheduledRunClaim extends ScheduledRunV1 {
  target: { kind: 'orchestrator' } | { kind: 'team_lead'; team: string };
  timeoutMs: number;
  maxRetries: number;
  requiredContext: unknown;
  deliveryBehavior: unknown;
  overlapPolicy: 'skip' | 'allow';
  missedRunPolicy: 'skip' | 'run_once' | 'bounded_catch_up';
}

function deliveryRecord(row: DeliveryRow): DeliveryRecordV1 {
  return DeliveryRecordSchemaV1.parse({
    schemaName: 'delivery-record',
    schemaVersion: 1,
    deliveryId: row.delivery_id,
    householdId: row.household_id,
    conversationId: row.conversation_id,
    channel: row.channel,
    idempotencyKey: row.idempotency_key,
    responseHash: row.response_hash,
    status: row.status,
    destination: row.destination,
    ...(row.platform_message_id === null ? {} : { platformMessageId: row.platform_message_id }),
    attemptCount: row.attempt_count,
    ...(row.failure_category === null ? {} : { failureCategory: row.failure_category }),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function scheduledRun(row: ScheduledRunRow): ScheduledRunV1 {
  return ScheduledRunSchemaV1.parse({
    schemaName: 'scheduled-run',
    schemaVersion: 1,
    occurrenceId: row.occurrence_id,
    jobId: row.job_id,
    jobVersion: row.job_version,
    householdId: row.household_id,
    runKey: row.run_key,
    scheduledFor: row.scheduled_for.toISOString(),
    status: row.status,
    attemptCount: row.attempt_count,
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.delivery_id === null ? {} : { deliveryId: row.delivery_id }),
    ...(row.failure_category === null ? {} : { failureCategory: row.failure_category }),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

export class PostgresDeliveryRepository {
  constructor(private readonly pool: Pool) {}

  async recordInboundMessage(candidate: unknown): Promise<{ inserted: boolean }> {
    const input = InboundChannelMessageSchemaV1.parse(candidate);
    const result = await this.pool.query(
      `INSERT INTO operations.channel_messages
       (conversation_id, household_id, direction, channel, external_message_id,
        body, speaker, attachments, metadata)
       SELECT conversation.id, conversation.household_id, 'inbound', $1, $2, $3, $4, $5, $6
       FROM operations.channel_conversations conversation
       JOIN operations.households household ON household.id = conversation.household_id
       WHERE household.household_id = $7 AND conversation.conversation_id = $8
       ON CONFLICT (household_id, channel, external_message_id) DO NOTHING`,
      [
        input.channel,
        input.externalMessageId,
        input.body,
        JSON.stringify(input.speaker),
        JSON.stringify(input.attachments),
        JSON.stringify(input.metadata),
        input.householdId,
        input.conversationId,
      ],
    );
    if (result.rowCount === 1) return { inserted: true };

    const existing = await this.pool.query(
      `SELECT 1 FROM operations.channel_messages message
       JOIN operations.households household ON household.id = message.household_id
       WHERE household.household_id = $1 AND message.channel = $2 AND message.external_message_id = $3`,
      [input.householdId, input.channel, input.externalMessageId],
    );
    if ((existing.rowCount ?? 0) > 0) return { inserted: false };
    throw this.notFound('channel_conversation_not_found', input.conversationId);
  }

  async reserveDelivery(candidate: ReservedDeliveryInput): Promise<DeliveryRecordV1> {
    const response = OrchestratorFinalResponseSchemaV1.parse(candidate.response);
    const deliveryId = DeliveryIdSchema.parse(candidate.deliveryId);
    const inserted = await this.pool.query<DeliveryRow>(
      `INSERT INTO operations.outbound_deliveries
       (delivery_id, household_id, conversation_id, idempotency_key, response_hash,
        final_response, status, channel, destination, attempt_count)
       SELECT $1, conversation.household_id, conversation.id, $2, $3, $4, 'pending', $5, $6, 0
       FROM operations.channel_conversations conversation
       JOIN operations.households household ON household.id = conversation.household_id
       WHERE household.household_id = $7 AND conversation.conversation_id = $8
       ON CONFLICT (household_id, idempotency_key) DO NOTHING
       RETURNING delivery_id, $7 AS household_id, $8 AS conversation_id, channel,
         idempotency_key, response_hash, status, destination, platform_message_id,
         attempt_count, failure_category, created_at, updated_at`,
      [
        deliveryId,
        candidate.idempotencyKey,
        response.responseHash,
        JSON.stringify(response),
        response.delivery.channel,
        JSON.stringify(response.delivery.destination),
        response.householdId,
        response.conversationId,
      ],
    );
    if (inserted.rows[0] !== undefined) return deliveryRecord(inserted.rows[0]);

    const existing = await this.findByIdempotency(response.householdId, candidate.idempotencyKey);
    if (existing !== undefined) return existing;
    throw this.notFound('delivery_conversation_not_found', response.conversationId);
  }

  async markDelivered(
    householdId: string,
    deliveryId: string,
    platformMessageId: string,
  ): Promise<DeliveryRecordV1> {
    return this.updateDelivery(
      householdId,
      deliveryId,
      `status = 'delivered', platform_message_id = $3, failure_category = NULL,
       attempt_count = attempt_count + 1, updated_at = clock_timestamp()`,
      [platformMessageId],
    );
  }

  async markDeliveryFailed(
    householdId: string,
    deliveryId: string,
    status: 'failed' | 'ambiguous',
    failureCategory: string,
  ): Promise<DeliveryRecordV1> {
    return this.updateDelivery(
      householdId,
      deliveryId,
      `status = $3, failure_category = $4, attempt_count = attempt_count + 1,
       updated_at = clock_timestamp()`,
      [status, failureCategory],
    );
  }

  private async findByIdempotency(
    householdId: string,
    idempotencyKey: string,
  ): Promise<DeliveryRecordV1 | undefined> {
    const result = await this.pool.query<DeliveryRow>(
      `SELECT delivery.delivery_id, household.household_id, conversation.conversation_id,
              delivery.channel, delivery.idempotency_key, delivery.response_hash, delivery.status,
              delivery.destination, delivery.platform_message_id, delivery.attempt_count,
              delivery.failure_category, delivery.created_at, delivery.updated_at
       FROM operations.outbound_deliveries delivery
       JOIN operations.households household ON household.id = delivery.household_id
       JOIN operations.channel_conversations conversation ON conversation.id = delivery.conversation_id
       WHERE household.household_id = $1 AND delivery.idempotency_key = $2`,
      [HouseholdIdSchema.parse(householdId), idempotencyKey],
    );
    return result.rows[0] === undefined ? undefined : deliveryRecord(result.rows[0]);
  }

  private async updateDelivery(
    householdId: string,
    deliveryId: string,
    assignmentSql: string,
    values: string[],
  ): Promise<DeliveryRecordV1> {
    const result = await this.pool.query<DeliveryRow>(
      `UPDATE operations.outbound_deliveries delivery
       SET ${assignmentSql}
       FROM operations.households household, operations.channel_conversations conversation
       WHERE household.id = delivery.household_id
         AND conversation.id = delivery.conversation_id
         AND household.household_id = $1
         AND delivery.delivery_id = $2
       RETURNING delivery.delivery_id, household.household_id, conversation.conversation_id,
         delivery.channel, delivery.idempotency_key, delivery.response_hash, delivery.status,
         delivery.destination, delivery.platform_message_id, delivery.attempt_count,
         delivery.failure_category, delivery.created_at, delivery.updated_at`,
      [HouseholdIdSchema.parse(householdId), DeliveryIdSchema.parse(deliveryId), ...values],
    );
    if (result.rows[0] === undefined) throw this.notFound('delivery_not_found', deliveryId);
    return deliveryRecord(result.rows[0]);
  }

  private notFound(code: string, id: string): PlusOneError {
    return new PlusOneError({ category: 'validation_rejected', code,
      message: 'Operational delivery record was not found', retry: 'never',
      receiptLookupRequired: false, details: { id } });
  }
}

export class PostgresSchedulerRepository {
  constructor(
    private readonly pool: Pool,
    private readonly ids: { nextOccurrenceId: () => string },
  ) {}

  async claimDueRuns(now: string, limit: number): Promise<ScheduledRunClaim[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const due = await client.query<DueJobRow>(
        `SELECT job.id::text AS database_id, job.job_id, household.household_id,
                job.version, job.target_kind, job.target_team, job.next_eligible_run_at,
                job.timeout_ms, job.max_retries, job.required_context,
                job.delivery_behavior, job.overlap_policy, job.missed_run_policy
         FROM operations.scheduled_jobs job
         JOIN operations.households household ON household.id = job.household_id
         WHERE job.enabled AND job.next_eligible_run_at <= $1::timestamptz
           AND (
             job.overlap_policy = 'allow'
             OR NOT EXISTS (
               SELECT 1 FROM operations.scheduled_runs active
               WHERE active.household_id = job.household_id
                 AND active.job_id = job.job_id
                 AND active.status IN ('claimed', 'running')
             )
           )
         ORDER BY job.next_eligible_run_at, job.id
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      const claims: ScheduledRunClaim[] = [];
      for (const job of due.rows) {
        const scheduledFor = job.next_eligible_run_at.toISOString();
        const runKey = `${job.job_id}:${job.version}:${scheduledFor}`;
        const inserted = await client.query<ScheduledRunRow>(
          `INSERT INTO operations.scheduled_runs
           (occurrence_id, household_id, job_id, job_version, run_key, scheduled_for,
            status, attempt_count)
           SELECT $1, id, $2, $3, $4, $5::timestamptz, 'claimed', 1
           FROM operations.households WHERE household_id = $6
           ON CONFLICT (household_id, run_key) DO NOTHING
           RETURNING occurrence_id, job_id, job_version, $6 AS household_id, run_key,
             scheduled_for, status, attempt_count, task_id, delivery_id,
             failure_category, created_at, updated_at`,
          [
            this.ids.nextOccurrenceId(),
            job.job_id,
            job.version,
            runKey,
            scheduledFor,
            job.household_id,
          ],
        );
        if (inserted.rows[0] === undefined) continue;
        claims.push({
          ...scheduledRun(inserted.rows[0]),
          target: job.target_kind === 'orchestrator'
            ? { kind: 'orchestrator' }
            : { kind: 'team_lead', team: job.target_team ?? '' },
          timeoutMs: job.timeout_ms,
          maxRetries: job.max_retries,
          requiredContext: job.required_context,
          deliveryBehavior: job.delivery_behavior,
          overlapPolicy: job.overlap_policy,
          missedRunPolicy: job.missed_run_policy,
        });
      }
      await client.query('COMMIT');
      return claims;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async completeRun(input: {
    householdId: string;
    occurrenceId: string;
    status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'skipped';
    taskId?: string;
    deliveryId?: string;
    failureCategory?: string;
  }): Promise<ScheduledRunV1> {
    const result = await this.pool.query<ScheduledRunRow>(
      `UPDATE operations.scheduled_runs run
       SET status = $1,
           task_id = COALESCE($2, task_id),
           delivery_id = COALESCE($3, delivery_id),
           failure_category = $4,
           updated_at = clock_timestamp()
       FROM operations.households household
       WHERE household.id = run.household_id
         AND household.household_id = $5
         AND run.occurrence_id = $6
         AND run.status IN ('claimed', 'running')
       RETURNING run.occurrence_id, run.job_id, run.job_version, household.household_id,
         run.run_key, run.scheduled_for, run.status, run.attempt_count,
         run.task_id, run.delivery_id, run.failure_category, run.created_at, run.updated_at`,
      [
        input.status,
        input.taskId ?? null,
        input.deliveryId ?? null,
        input.failureCategory ?? null,
        HouseholdIdSchema.parse(input.householdId),
        input.occurrenceId,
      ],
    );
    if (result.rows[0] === undefined) {
      throw new PlusOneError({ category: 'constraint_violation', code: 'scheduled_run_not_completable',
        message: 'Scheduled run was not claimable or already terminal', retry: 'after_state_resolution',
        receiptLookupRequired: false, details: { occurrenceId: input.occurrenceId } });
    }
    return scheduledRun(result.rows[0]);
  }
}
