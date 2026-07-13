import {
  ArtifactIdSchema,
  CheckerVerdictSchemaV1,
  HouseholdIdSchema,
  PlusOneError,
  RunIdSchema,
  RuntimePolicySchemaV1,
  TaskIdSchema,
  TaskStatusSchemaV1,
  UtcInstantSchema,
  type CheckerVerdictV1,
  type RuntimePolicyV1,
  type TaskStatusV1,
} from '@plus-one/contracts';
import type { Pool, PoolClient } from 'pg';

export interface VerificationTaskRecord {
  householdId: string;
  taskId: string;
  parentTaskId?: string;
  team: string;
  status: TaskStatusV1;
  attemptLimit: number;
  deadlineAt?: string;
  failureCategory?: string;
  resumable: boolean;
  currentMakerArtifactId?: string;
  currentMakerArtifactHash?: string;
  currentCheckerArtifactId?: string;
  updatedAt: string;
}

export interface CreateTaskRecord {
  householdId: string;
  taskId: string;
  parentTaskId?: string;
  team: string;
  attemptLimit: number;
  deadlineAt?: string;
}

export interface TransitionRecord {
  householdId: string;
  taskId: string;
  expectedFrom: TaskStatusV1;
  to: TaskStatusV1;
  reasonCode: string;
  responsibleComponent: string;
  terminal?: boolean;
  failureCategory?: string;
  resumable?: boolean;
}

interface TaskRow {
  household_id: string;
  task_id: string;
  parent_task_id: string | null;
  team: string;
  status: string;
  attempt_limit: number;
  deadline_at: Date | null;
  failure_category: string | null;
  resumable: boolean;
  current_maker_artifact_id: string | null;
  current_maker_artifact_hash: string | null;
  current_checker_artifact_id: string | null;
  updated_at: Date;
}

interface InsertedTaskRow {
  task_id: string;
  parent_task_id: string | null;
  team: string;
  status: string;
  attempt_limit: number;
  deadline_at: Date | null;
  failure_category: string | null;
  resumable: boolean;
  current_maker_artifact_id: string | null;
  current_maker_artifact_hash: string | null;
  current_checker_artifact_id: string | null;
  updated_at: Date;
}

function taskRecord(row: TaskRow): VerificationTaskRecord {
  return {
    householdId: row.household_id,
    taskId: row.task_id,
    ...(row.parent_task_id === null ? {} : { parentTaskId: row.parent_task_id }),
    team: row.team,
    status: TaskStatusSchemaV1.parse(row.status),
    attemptLimit: row.attempt_limit,
    ...(row.deadline_at === null ? {} : { deadlineAt: row.deadline_at.toISOString() }),
    ...(row.failure_category === null ? {} : { failureCategory: row.failure_category }),
    resumable: row.resumable,
    ...(row.current_maker_artifact_id === null
      ? {}
      : { currentMakerArtifactId: row.current_maker_artifact_id }),
    ...(row.current_maker_artifact_hash === null
      ? {}
      : { currentMakerArtifactHash: row.current_maker_artifact_hash }),
    ...(row.current_checker_artifact_id === null
      ? {}
      : { currentCheckerArtifactId: row.current_checker_artifact_id }),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function loadTaskForUpdate(
  client: PoolClient,
  householdId: string,
  taskId: string,
): Promise<TaskRow> {
  const result = await client.query<TaskRow>(
    `SELECT h.household_id, t.task_id, t.parent_task_id, t.team, t.status, t.attempt_limit,
            t.deadline_at, t.failure_category, t.resumable, t.current_maker_artifact_id,
            t.current_maker_artifact_hash, t.current_checker_artifact_id, t.updated_at
     FROM operations.verification_tasks t
     JOIN operations.households h ON h.id = t.household_id
     WHERE h.household_id = $1 AND t.task_id = $2
     FOR UPDATE OF t`,
    [HouseholdIdSchema.parse(householdId), TaskIdSchema.parse(taskId)],
  );
  const row = result.rows[0];

  if (row === undefined) {
    throw new PlusOneError({
      category: 'validation_rejected',
      code: 'task_not_found',
      message: 'Verification task was not found',
      retry: 'never',
      receiptLookupRequired: false,
      details: { taskId },
    });
  }

  return row;
}

export class PostgresVerificationLedgerRepository {
  constructor(private readonly pool: Pool) {}

  async createTask(input: CreateTaskRecord): Promise<VerificationTaskRecord> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const inserted = await client.query<InsertedTaskRow>(
        `INSERT INTO operations.verification_tasks
         (task_id, household_id, parent_task_id, team, status, attempt_limit, deadline_at)
         SELECT $1, h.id, $2, $3, 'created', $4, $5::timestamptz
         FROM operations.households h
         WHERE h.household_id = $6
         RETURNING task_id, parent_task_id, team, status, attempt_limit, deadline_at, failure_category,
                   resumable, current_maker_artifact_id, current_maker_artifact_hash,
                   current_checker_artifact_id, updated_at`,
        [
          TaskIdSchema.parse(input.taskId),
          input.parentTaskId === undefined ? null : TaskIdSchema.parse(input.parentTaskId),
          input.team,
          input.attemptLimit,
          input.deadlineAt === undefined ? null : UtcInstantSchema.parse(input.deadlineAt),
          HouseholdIdSchema.parse(input.householdId),
        ],
      );

      if (inserted.rowCount !== 1) {
        throw new PlusOneError({
          category: 'validation_rejected',
          code: 'task_household_not_found',
          message: 'Verification task household was not found',
          retry: 'never',
          receiptLookupRequired: false,
          details: { taskId: input.taskId },
        });
      }

      await client.query(
        `INSERT INTO operations.task_transitions
         (household_id, task_id, sequence, from_status, to_status, reason_code, responsible_component)
         SELECT id, $1, 1, NULL, 'created', 'task_created', 'VerificationRuntime'
         FROM operations.households
         WHERE household_id = $2`,
        [input.taskId, input.householdId],
      );
      await client.query('COMMIT');

      return taskRecord({
        household_id: input.householdId,
        ...inserted.rows[0]!,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async transition(input: TransitionRecord): Promise<VerificationTaskRecord> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const current = await loadTaskForUpdate(client, input.householdId, input.taskId);

      if (current.status !== input.expectedFrom) {
        throw new PlusOneError({
          category: 'constraint_violation',
          code: 'stale_task_state',
          message: 'Task state changed before transition could be accepted',
          retry: 'safe',
          receiptLookupRequired: false,
          details: {
            taskId: input.taskId,
            expected: input.expectedFrom,
            actual: current.status,
          },
        });
      }

      const sequence = await client.query<{ next: number }>(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next
         FROM operations.task_transitions
         WHERE household_id = (SELECT id FROM operations.households WHERE household_id = $1)
           AND task_id = $2`,
        [input.householdId, input.taskId],
      );

      await client.query(
        `INSERT INTO operations.task_transitions
         (household_id, task_id, sequence, from_status, to_status, reason_code, responsible_component)
         SELECT id, $1, $2, $3, $4, $5, $6
         FROM operations.households
         WHERE household_id = $7`,
        [
          input.taskId,
          sequence.rows[0]!.next,
          input.expectedFrom,
          input.to,
          input.reasonCode,
          input.responsibleComponent,
          input.householdId,
        ],
      );

      await client.query(
        `UPDATE operations.verification_tasks
         SET status = $1,
             failure_category = $2,
             resumable = COALESCE($3, resumable),
             terminal_at = CASE WHEN $4 THEN clock_timestamp() ELSE NULL END,
             updated_at = clock_timestamp()
         WHERE household_id = (SELECT id FROM operations.households WHERE household_id = $5)
           AND task_id = $6`,
        [
          input.to,
          input.failureCategory ?? null,
          input.resumable ?? null,
          input.terminal ?? false,
          input.householdId,
          input.taskId,
        ],
      );

      const updated = await loadTaskForUpdate(client, input.householdId, input.taskId);
      await client.query('COMMIT');
      return taskRecord(updated);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async selectExecutionContract(input: {
    householdId: string;
    taskId: string;
    skill: { skillName: string; skillVersion: number; contentHash: string };
    inputSchema: { schemaName: string; schemaVersion: number };
    outputSchema: { schemaName: string; schemaVersion: number };
    policy: RuntimePolicyV1;
  }): Promise<void> {
    const policy = RuntimePolicySchemaV1.parse(input.policy);
    const result = await this.pool.query(
      `UPDATE operations.verification_tasks
       SET selected_skill_name = $1,
           selected_skill_version = $2,
           selected_skill_hash = $3,
           input_schema_name = $4,
           input_schema_version = $5,
           output_schema_name = $6,
           output_schema_version = $7,
           runtime_policy_name = $8,
           runtime_policy_version = $9,
           runtime_policy_snapshot = $10::jsonb,
           updated_at = clock_timestamp()
       WHERE household_id = (SELECT id FROM operations.households WHERE household_id = $11)
         AND task_id = $12
         AND status = 'created'`,
      [
        input.skill.skillName,
        input.skill.skillVersion,
        input.skill.contentHash,
        input.inputSchema.schemaName,
        input.inputSchema.schemaVersion,
        input.outputSchema.schemaName,
        input.outputSchema.schemaVersion,
        policy.identity.policyName,
        policy.identity.policyVersion,
        JSON.stringify(policy),
        input.householdId,
        input.taskId,
      ],
    );

    if (result.rowCount !== 1) {
      throw new PlusOneError({
        category: 'constraint_violation',
        code: 'execution_contract_not_selectable',
        message: 'Execution contract can only be selected for a created task',
        retry: 'never',
        receiptLookupRequired: false,
        details: { taskId: input.taskId },
      });
    }
  }

  async linkMakerArtifact(input: {
    householdId: string;
    taskId: string;
    artifactId: string;
    artifactHash: string;
  }): Promise<void> {
    const result = await this.pool.query(
      `UPDATE operations.verification_tasks
       SET current_maker_artifact_id = $1,
           current_maker_artifact_hash = $2,
           current_checker_artifact_id = NULL,
           updated_at = clock_timestamp()
       WHERE household_id = (SELECT id FROM operations.households WHERE household_id = $3)
         AND task_id = $4
         AND status = 'maker_running'`,
      [
        ArtifactIdSchema.parse(input.artifactId),
        input.artifactHash,
        input.householdId,
        input.taskId,
      ],
    );

    if (result.rowCount !== 1) {
      throw new PlusOneError({
        category: 'constraint_violation',
        code: 'maker_artifact_not_linkable',
        message: 'Maker artifact can only be linked while the maker is running',
        retry: 'never',
        receiptLookupRequired: false,
        details: { taskId: input.taskId },
      });
    }
  }

  async recordCheckerVerdict(input: {
    householdId: string;
    taskId: string;
    checkerArtifactId: string;
    verdict: CheckerVerdictV1;
  }): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const task = await loadTaskForUpdate(client, input.householdId, input.taskId);
      const verdict = CheckerVerdictSchemaV1.parse(input.verdict);

      if (
        task.status !== 'checker_running' ||
        task.current_maker_artifact_id !== verdict.coveredArtifactId ||
        task.current_maker_artifact_hash !== verdict.coveredArtifactHash
      ) {
        throw new PlusOneError({
          category: 'checker_rejected',
          code: 'checker_coverage_mismatch',
          message: 'Checker verdict does not cover the active maker artifact',
          retry: 'never',
          receiptLookupRequired: false,
          details: { taskId: input.taskId },
        });
      }

      const inserted = await client.query(
        `INSERT INTO operations.checker_verdicts
         (household_id, task_id, checker_artifact_id, covered_artifact_id, covered_artifact_hash, verdict)
         SELECT id, $1, $2, $3, $4, $5
         FROM operations.households
         WHERE household_id = $6
         ON CONFLICT ON CONSTRAINT checker_verdicts_unique DO NOTHING`,
        [
          input.taskId,
          ArtifactIdSchema.parse(input.checkerArtifactId),
          verdict.coveredArtifactId,
          verdict.coveredArtifactHash,
          verdict.verdict,
          input.householdId,
        ],
      );
      if (inserted.rowCount === 0) {
        const existing = await client.query<{
          covered_artifact_id: string;
          covered_artifact_hash: string;
          verdict: string;
        }>(
          `SELECT v.covered_artifact_id, v.covered_artifact_hash, v.verdict
           FROM operations.checker_verdicts v
           JOIN operations.households h ON h.id = v.household_id
           WHERE h.household_id = $1
             AND v.task_id = $2
             AND v.checker_artifact_id = $3`,
          [input.householdId, input.taskId, input.checkerArtifactId],
        );
        const row = existing.rows[0];
        if (row === undefined
          || row.covered_artifact_id !== verdict.coveredArtifactId
          || row.covered_artifact_hash !== verdict.coveredArtifactHash
          || row.verdict !== verdict.verdict) {
          throw new PlusOneError({
            category: 'constraint_violation',
            code: 'checker_verdict_conflict',
            message: 'Checker artifact is already linked to a different verdict.',
            retry: 'never',
            receiptLookupRequired: false,
            details: { taskId: input.taskId, checkerArtifactId: input.checkerArtifactId },
          });
        }
      }

      await client.query(
        `UPDATE operations.verification_tasks
         SET current_checker_artifact_id = $1,
             updated_at = clock_timestamp()
         WHERE household_id = (SELECT id FROM operations.households WHERE household_id = $2)
           AND task_id = $3`,
        [input.checkerArtifactId, input.householdId, input.taskId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async startRun(input: {
    householdId: string;
    taskId: string;
    runId: string;
    role: string;
    roleVersion: number;
    modelId: string;
    policy: RuntimePolicyV1;
  }): Promise<void> {
    const policy = RuntimePolicySchemaV1.parse(input.policy);
    const result = await this.pool.query(
      `INSERT INTO operations.agent_runs
       (run_id, household_id, task_id, role, role_version, model_id,
        runtime_policy_name, runtime_policy_version, runtime_policy_snapshot, status)
       SELECT $1, id, $2, $3, $4, $5, $6, $7, $8::jsonb, 'running'
       FROM operations.households
       WHERE household_id = $9`,
      [
        RunIdSchema.parse(input.runId),
        input.taskId,
        input.role,
        input.roleVersion,
        input.modelId,
        policy.identity.policyName,
        policy.identity.policyVersion,
        JSON.stringify(policy),
        input.householdId,
      ],
    );

    if (result.rowCount !== 1) {
      throw new PlusOneError({
        category: 'validation_rejected',
        code: 'run_task_not_found',
        message: 'Cannot start an agent run for a missing verification task',
        retry: 'never',
        receiptLookupRequired: false,
        details: { taskId: input.taskId, runId: input.runId },
      });
    }
  }

  async finishRun(
    runId: string,
    status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out',
    failureCategory?: string,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE operations.agent_runs
       SET status = $1,
           ended_at = clock_timestamp(),
           failure_category = $2
       WHERE run_id = $3
         AND status = 'running'`,
      [status, failureCategory ?? null, RunIdSchema.parse(runId)],
    );

    if (result.rowCount !== 1) {
      throw new PlusOneError({
        category: 'serialization_conflict',
        code: 'run_not_running',
        message: 'Agent run is missing or no longer running',
        retry: 'after_state_resolution',
        receiptLookupRequired: false,
        details: { runId },
      });
    }
  }

  async startAttempt(input: {
    householdId: string;
    taskId: string;
    runId: string;
    role: string;
    ordinal: number;
    configuredLimit: number;
    resumable: boolean;
  }): Promise<void> {
    const result = await this.pool.query(
      `INSERT INTO operations.agent_attempts
       (household_id, task_id, run_id, role, ordinal, configured_limit, outcome, resumable)
       SELECT id, $1, $2, $3, $4, $5, 'running', $6
       FROM operations.households
       WHERE household_id = $7`,
      [
        input.taskId,
        RunIdSchema.parse(input.runId),
        input.role,
        input.ordinal,
        input.configuredLimit,
        input.resumable,
        input.householdId,
      ],
    );

    if (result.rowCount !== 1) {
      throw new PlusOneError({
        category: 'validation_rejected',
        code: 'attempt_run_not_found',
        message: 'Cannot start an attempt for a missing verification task and run',
        retry: 'never',
        receiptLookupRequired: false,
        details: { taskId: input.taskId, runId: input.runId },
      });
    }
  }

  async finishAttempt(input: {
    householdId: string;
    taskId: string;
    role: string;
    ordinal: number;
    outcome:
      | 'succeeded'
      | 'schema_failed'
      | 'model_failed'
      | 'tool_failed'
      | 'timed_out'
      | 'cancelled';
    retryCategory?: string;
    resumable: boolean;
  }): Promise<void> {
    const result = await this.pool.query(
      `UPDATE operations.agent_attempts
       SET outcome = $1,
           retry_category = $2,
           resumable = $3,
           ended_at = clock_timestamp()
       WHERE household_id = (SELECT id FROM operations.households WHERE household_id = $4)
         AND task_id = $5
         AND role = $6
         AND ordinal = $7
         AND outcome = 'running'`,
      [
        input.outcome,
        input.retryCategory ?? null,
        input.resumable,
        input.householdId,
        input.taskId,
        input.role,
        input.ordinal,
      ],
    );

    if (result.rowCount !== 1) {
      throw new PlusOneError({
        category: 'serialization_conflict',
        code: 'attempt_not_running',
        message: 'Agent attempt is missing or no longer running',
        retry: 'after_state_resolution',
        receiptLookupRequired: false,
        details: {
          taskId: input.taskId,
          role: input.role,
          ordinal: input.ordinal,
        },
      });
    }
  }

  async findLatestVerdict(
    householdId: string,
    taskId: string,
  ): Promise<CheckerVerdictV1 | undefined> {
    const result = await this.pool.query<{
      verdict: CheckerVerdictV1['verdict'];
      covered_artifact_id: string;
      covered_artifact_hash: string;
      payload: unknown;
    }>(
      `SELECT v.verdict, v.covered_artifact_id, v.covered_artifact_hash, a.payload
       FROM operations.checker_verdicts v
       JOIN operations.artifacts a
         ON a.household_id = v.household_id
        AND a.task_id = v.task_id
        AND a.artifact_id = v.checker_artifact_id
       JOIN operations.households h ON h.id = v.household_id
       WHERE h.household_id = $1
         AND v.task_id = $2
       ORDER BY v.created_at DESC, v.id DESC
       LIMIT 1`,
      [householdId, taskId],
    );
    const row = result.rows[0];

    if (row === undefined) {
      return undefined;
    }

    const parsed = CheckerVerdictSchemaV1.parse(row.payload);

    if (
      parsed.verdict !== row.verdict ||
      parsed.coveredArtifactId !== row.covered_artifact_id ||
      parsed.coveredArtifactHash !== row.covered_artifact_hash
    ) {
      throw new PlusOneError({
        category: 'constraint_violation',
        code: 'checker_verdict_storage_mismatch',
        message: 'Stored checker verdict columns do not match the immutable checker artifact',
        retry: 'never',
        receiptLookupRequired: false,
        details: { taskId },
      });
    }

    return parsed;
  }

  async findTask(
    householdId: string,
    taskId: string,
  ): Promise<VerificationTaskRecord | undefined> {
    const result = await this.pool.query<TaskRow>(
      `SELECT h.household_id, t.task_id, t.parent_task_id, t.team, t.status, t.attempt_limit,
              t.deadline_at, t.failure_category, t.resumable, t.current_maker_artifact_id,
              t.current_maker_artifact_hash, t.current_checker_artifact_id, t.updated_at
       FROM operations.verification_tasks t
       JOIN operations.households h ON h.id = t.household_id
       WHERE h.household_id = $1
         AND t.task_id = $2`,
      [householdId, taskId],
    );

    return result.rows[0] === undefined ? undefined : taskRecord(result.rows[0]);
  }

  async listResumable(): Promise<VerificationTaskRecord[]> {
    const result = await this.pool.query<TaskRow>(
      `SELECT h.household_id, t.task_id, t.parent_task_id, t.team, t.status, t.attempt_limit,
              t.deadline_at, t.failure_category, t.resumable, t.current_maker_artifact_id,
              t.current_maker_artifact_hash, t.current_checker_artifact_id, t.updated_at
       FROM operations.verification_tasks t
       JOIN operations.households h ON h.id = t.household_id
       WHERE t.resumable
         AND t.status NOT IN (
           'verified',
           'partial',
           'insufficient_evidence',
           'conflicted',
           'failed',
           'execution_failed',
           'readback_failed'
         )
       ORDER BY t.updated_at, t.task_id`,
      [],
    );

    return result.rows.map(taskRecord);
  }
}
