import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  PostgresDomainCommandBridge,
  PostgresMutationCommandRepository,
  PostgresVerificationLedgerRepository,
} from '@plus-one/database';
import { checkedCommand, seedCheckedProposal } from '../helpers/checked-mutation.js';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;

afterEach(async () => {
  await context?.cleanup();
  context = undefined;
});

describe('mutation command persistence', () => {
  it('returns the existing command for an exact same-key replay', async () => {
    context = await createPostgresTestContext('mutation_same_key');
    const operations = new Pool({ connectionString: context.roleUrls.operations });
    const owner = new Pool({ connectionString: context.migratorUrl });
    await seedCheckedProposal(owner);
    const repository = new PostgresMutationCommandRepository(operations);
    const first = await repository.register(checkedCommand());
    const replay = await repository.register(checkedCommand());
    expect(replay).toEqual(first);
    await operations.end();
    await owner.end();
  });

  it('rejects same-key drift and a second key for the same checked proposal', async () => {
    context = await createPostgresTestContext('mutation_drift');
    const operations = new Pool({ connectionString: context.roleUrls.operations });
    const owner = new Pool({ connectionString: context.migratorUrl });
    await seedCheckedProposal(owner);
    const repository = new PostgresMutationCommandRepository(operations);
    await repository.register(checkedCommand());
    await expect(repository.register({ ...checkedCommand(), commandType: 'other_command' }))
      .rejects.toMatchObject({ code: 'idempotency_key_reused' });
    await expect(repository.register(checkedCommand({
      commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J2K',
      idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J2K',
    }))).rejects.toMatchObject({ code: 'checked_proposal_already_commanded' });
    await operations.end();
    await owner.end();
  });

  it('claims and commits the receipt on the accounting transaction client', async () => {
    context = await createPostgresTestContext('mutation_bridge');
    const operations = new Pool({ connectionString: context.roleUrls.operations });
    const owner = new Pool({ connectionString: context.migratorUrl });
    await seedCheckedProposal(owner);
    const repository = new PostgresMutationCommandRepository(operations);
    await repository.register(checkedCommand());
    await new PostgresVerificationLedgerRepository(operations).transition({
      householdId: checkedCommand().householdId,
      taskId: checkedCommand().taskId,
      expectedFrom: 'checker_validated',
      to: 'execution_pending',
      reasonCode: 'test_execution_pending',
      responsibleComponent: 'MutationBridgeIntegrationTest',
    });
    await repository.markExecutionPending(checkedCommand().householdId, checkedCommand().commandId);

    const accounting = new Pool({ connectionString: context.roleUrls.accounting });
    const client = await accounting.connect();
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const bridge = new PostgresDomainCommandBridge();
    await expect(bridge.claim(client, checkedCommand().householdId, checkedCommand().commandId))
      .resolves.toMatchObject({ status: 'execution_pending' });
    await bridge.commit(client, {
      householdId: checkedCommand().householdId,
      commandId: checkedCommand().commandId,
      receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      committedRecords: [{ recordType: 'test.record', recordId: 'record_1' }],
      expectedState: { recordId: 'record_1' },
      expectedStateHash: 'b'.repeat(64),
    });
    await client.query('COMMIT');
    await expect(repository.findReceiptByCommand(
      checkedCommand().householdId,
      checkedCommand().commandId,
    )).resolves.toMatchObject({ receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K' });
    client.release();
    await accounting.end();
    await operations.end();
    await owner.end();
  });
});
