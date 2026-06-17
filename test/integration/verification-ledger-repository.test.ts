import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresVerificationLedgerRepository } from '@plus-one/database';
import type { VerificationLedgerPort } from '@plus-one/runtime';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;

afterEach(async () => {
  await context?.cleanup();
  context = undefined;
});

async function seedHousehold(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ('hh_01JNZQ4A9B8C7D6E5F4G3H2J1K', 'USD', 'UTC')`,
  );
}

describe('PostgresVerificationLedgerRepository', () => {
  it('creates a task and serializes compare-and-transition updates', async () => {
    context = await createPostgresTestContext('ledger_transition');
    const pool = new Pool({ connectionString: context.roleUrls.operations });

    try {
      await seedHousehold(pool);
      const repository = new PostgresVerificationLedgerRepository(pool);
      const port: VerificationLedgerPort = repository;
      await port.createTask({
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        team: 'query',
        attemptLimit: 2,
        deadlineAt: '2026-06-14T11:00:00.000Z',
      });

      const first = repository.transition({
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        expectedFrom: 'created',
        to: 'skill_selected',
        reasonCode: 'contract_selected',
        responsibleComponent: 'VerificationRuntime',
      });
      const conflicting = repository.transition({
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        expectedFrom: 'created',
        to: 'skill_selected',
        reasonCode: 'duplicate_writer',
        responsibleComponent: 'VerificationRuntime',
      });
      const results = await Promise.allSettled([first, conflicting]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      expect(rejected?.reason).toMatchObject({ code: 'stale_task_state' });
    } finally {
      await pool.end();
    }
  });

  it('records run and attempt identity without transcripts or prompts', async () => {
    context = await createPostgresTestContext('ledger_attempt');
    const pool = new Pool({ connectionString: context.roleUrls.operations });

    try {
      await seedHousehold(pool);
      const repository = new PostgresVerificationLedgerRepository(pool);
      await repository.createTask({
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        team: 'query',
        attemptLimit: 2,
      });
      await repository.startRun({
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        runId: 'run_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        role: 'query-maker',
        roleVersion: 1,
        modelId: 'provider/model-a',
        policy: {
          identity: { policyName: 'query-maker', policyVersion: 1 },
          requiredCapabilities: ['structured_output'],
          primaryModel: 'provider/model-a',
          fallbackModels: [],
          maxModelSteps: 4,
          maxToolConcurrency: 1,
          maxAttempts: 2,
          maxModelRequestRetries: 1,
          maxProcessorRetries: 0,
          maxSandboxReproductions: 0,
          callDeadlineMs: 10_000,
          teamDeadlineMs: 20_000,
          endToEndDeadlineMs: 30_000,
          maxOutputBytes: 65_536,
        },
      });
      await repository.startAttempt({
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        runId: 'run_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        role: 'query-maker',
        ordinal: 1,
        configuredLimit: 2,
        resumable: true,
      });

      const columns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'operations' AND table_name IN ('agent_runs', 'agent_attempts')`,
      );

      expect(columns.rows.map((row) => row.column_name)).not.toContain('prompt');
      expect(columns.rows.map((row) => row.column_name)).not.toContain('transcript');

      const run = await pool.query(
        `SELECT role, model_id, runtime_policy_name, runtime_policy_version, runtime_policy_snapshot
         FROM operations.agent_runs
         WHERE run_id = $1`,
        ['run_01JNZQ4A9B8C7D6E5F4G3H2J1K'],
      );

      expect(run.rows[0]).toMatchObject({
        role: 'query-maker',
        model_id: 'provider/model-a',
        runtime_policy_name: 'query-maker',
        runtime_policy_version: 1,
        runtime_policy_snapshot: {
          identity: { policyName: 'query-maker', policyVersion: 1 },
        },
      });
    } finally {
      await pool.end();
    }
  });
});
