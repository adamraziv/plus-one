import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { CheckedCommandSchemaV1 } from '@plus-one/contracts';
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

describe('checked mutation concurrency', () => {
  it('returns one receipt and commits one journal for concurrent same-key callers', async () => {
    context = await createPostgresTestContext('mutation_concurrent_same_key');
    const owner = new Pool({ connectionString: context.migratorUrl });
    const { command } = await seedCheckedAccountingMutation(owner);
    const harness = createExecutor(context);
    closeHarness = harness.close;

    const results = await Promise.all(Array.from({ length: 8 }, () => harness.executor.execute(command)));
    expect(new Set(results.map((result) => result.receipt.receiptId))).toEqual(new Set([
      'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    ]));
    expect(results.every((result) => result.readback.ok)).toBe(true);
    expect((await owner.query('SELECT count(*)::int AS count FROM accounting.journals')).rows[0])
      .toEqual({ count: 1 });
    expect((await owner.query('SELECT count(*)::int AS count FROM operations.mutation_receipts')).rows[0])
      .toEqual({ count: 1 });
    await owner.end();
  });

  it('rejects a second idempotency key for the same exact checked proposal', async () => {
    context = await createPostgresTestContext('mutation_concurrent_new_key');
    const owner = new Pool({ connectionString: context.migratorUrl });
    const { command } = await seedCheckedAccountingMutation(owner);
    const harness = createExecutor(context);
    closeHarness = harness.close;

    const settled = await Promise.allSettled([
      harness.executor.execute(command),
      harness.executor.execute(CheckedCommandSchemaV1.parse({
        ...command,
        commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J2K',
        idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J2K',
      })),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await owner.query('SELECT count(*)::int AS count FROM accounting.journals')).rows[0])
      .toEqual({ count: 1 });
    await owner.end();
  });
});
