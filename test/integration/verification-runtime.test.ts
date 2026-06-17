import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  PostgresArtifactRepository,
  PostgresVerificationLedgerRepository,
} from '@plus-one/database';
import {
  ArtifactStore,
  RuntimePolicyRegistry,
  VerificationRuntime,
  inspectResumableTasks,
} from '@plus-one/runtime';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;

afterEach(async () => {
  await context?.cleanup();
  context = undefined;
});

describe('durable VerificationRuntime', () => {
  it('persists exact artifact coverage and reconstructs unfinished work after a fresh runtime instance', async () => {
    context = await createPostgresTestContext('runtime_restart');
    const pool = new Pool({ connectionString: context.roleUrls.operations });

    try {
      await pool.query(
        `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
         VALUES ('hh_01JNZQ4A9B8C7D6E5F4G3H2J1K', 'USD', 'UTC')`,
      );
      const ledger = new PostgresVerificationLedgerRepository(pool);
      const policies = new RuntimePolicyRegistry({
        models: { 'provider/model-a': ['structured_output'] },
        policies: [
          {
            identity: { policyName: 'test', policyVersion: 1 },
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
        ],
      });
      const runtime = new VerificationRuntime({
        ledger,
        artifacts: new ArtifactStore(new PostgresArtifactRepository(pool)),
        policies,
      });
      const ids = {
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      } as const;

      await runtime.createTask({
        ...ids,
        team: 'query',
        attemptLimit: 2,
        deadlineAt: '2099-01-01T00:00:00.000Z',
      });
      await runtime.selectContract({
        ...ids,
        skill: { skillName: 'lookup', skillVersion: 1, contentHash: 'a'.repeat(64) },
        inputSchema: { schemaName: 'lookup-input', schemaVersion: 1 },
        outputSchema: { schemaName: 'lookup-output', schemaVersion: 1 },
        policy: { policyName: 'test', policyVersion: 1 },
      });
      await runtime.beginMaker(ids);
      await runtime.validateMaker({
        ...ids,
        artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        schema: { schemaName: 'lookup-output', schemaVersion: 1 },
        payload: { result: 'frozen' },
      });
      await runtime.beginChecker(ids);

      const freshLedger = new PostgresVerificationLedgerRepository(pool);
      const inspection = await inspectResumableTasks(freshLedger, '2026-06-14T10:00:00.000Z');

      expect(inspection).toEqual([
        expect.objectContaining({
          action: 'retry_allowed',
          task: expect.objectContaining({ status: 'checker_running' }),
        }),
      ]);
    } finally {
      await pool.end();
    }
  });
});
