import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createExecutor, seedCheckedAccountingMutation } from '../helpers/checked-mutation.js';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;
let closeHarness: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeHarness?.();
  closeHarness = undefined;
  await context?.cleanup();
  context = undefined;
});

describe('checked accounting mutation', () => {
  it('commits one journal and reports success only after deterministic read-back', async () => {
    context = await createPostgresTestContext('checked_accounting');
    const owner = new Pool({ connectionString: context.migratorUrl });
    const { command } = await seedCheckedAccountingMutation(owner);
    const harness = createExecutor(context);
    closeHarness = harness.close;
    const result = await harness.executor.execute(command);

    expect(result).toMatchObject({
      status: 'readback_verified',
      receipt: { commandId: command.commandId },
      readback: { ok: true },
    });
    expect((await owner.query('SELECT count(*)::int AS count FROM accounting.journals')).rows[0])
      .toEqual({ count: 1 });
    expect((await owner.query('SELECT count(*)::int AS count FROM accounting.postings')).rows[0])
      .toEqual({ count: 2 });
    expect((await owner.query(
      `SELECT command.status AS command_status, task.status AS task_status
       FROM operations.mutation_commands command
       JOIN operations.households household ON household.id = command.household_id
       JOIN operations.verification_tasks task
         ON task.household_id = command.household_id AND task.task_id = command.task_id
       WHERE household.household_id = $1 AND command.command_id = $2`,
      [command.householdId, command.commandId],
    )).rows[0]).toEqual({ command_status: 'readback_verified', task_status: 'readback_verified' });
    await owner.end();
  });
});
