import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { createPostAccountingJournalHandler } from '@plus-one/accounting';
import { PostJournalProposalSchemaV1, ReadbackResultSchemaV1 } from '@plus-one/contracts';
import {
  PostgresDomainCommandBridge,
  PostgresMutationCommandRepository,
  PostgresVerificationLedgerRepository,
} from '@plus-one/database';
import {
  CommandStateResolver,
} from '@plus-one/mutations';
import { hashArtifact } from '@plus-one/runtime';
import {
  checkedCommand,
  seedCheckedAccountingMutation,
  seedCheckedProposal,
} from '../helpers/checked-mutation.js';
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

  it('repairs execution_pending task state from an already committed command without replay', async () => {
    context = await createPostgresTestContext('mutation_recover_committed');
    const fixture = await commitWithoutTaskTransition(context);
    const resolver = new CommandStateResolver({ commands: fixture.commands, ledger: fixture.ledger });
    await expect(resolver.reconcile(fixture.command.householdId, fixture.command.commandId))
      .resolves.toMatchObject({ status: 'committed' });
    await expect(fixture.ledger.findTask(fixture.command.householdId, fixture.command.taskId))
      .resolves.toMatchObject({ status: 'committed' });
    expect((await fixture.owner.query(
      'SELECT count(*)::int AS count FROM accounting.journals',
    )).rows[0]).toEqual({ count: 1 });
    expect((await fixture.owner.query(
      'SELECT count(*)::int AS count FROM operations.mutation_receipts',
    )).rows[0]).toEqual({ count: 1 });
    await fixture.close();
  });

  it('preserves readback_failed as terminal and never calls the command handler', async () => {
    context = await createPostgresTestContext('mutation_recover_readback_failed');
    const fixture = await commitWithoutTaskTransition(context);
    const resolver = new CommandStateResolver({ commands: fixture.commands, ledger: fixture.ledger });
    await resolver.reconcile(fixture.command.householdId, fixture.command.commandId);
    await fixture.commands.recordReadback(fixture.command.householdId, ReadbackResultSchemaV1.parse({
      schemaName: 'mutation-readback',
      schemaVersion: 1,
      readbackId: 'readback_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      commandId: fixture.command.commandId,
      receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      ok: false,
      checks: [{ kind: 'identifiers', status: 'failed', detailCode: 'journal_missing' }],
      mismatches: ['journal_missing'],
      observedStateHash: 'f'.repeat(64),
    }));
    const execute = vi.fn();
    await expect(resolver.reconcile(fixture.command.householdId, fixture.command.commandId))
      .resolves.toMatchObject({ status: 'readback_failed' });
    expect(execute).not.toHaveBeenCalled();
    await expect(fixture.ledger.findTask(fixture.command.householdId, fixture.command.taskId))
      .resolves.toMatchObject({ status: 'readback_failed' });
    expect((await fixture.owner.query(
      'SELECT count(*)::int AS count FROM accounting.journals',
    )).rows[0]).toEqual({ count: 1 });
    await fixture.close();
  });
});

async function commitWithoutTaskTransition(testContext: PostgresTestContext) {
  const owner = new Pool({ connectionString: testContext.migratorUrl });
  const { command } = await seedCheckedAccountingMutation(owner);
  const operations = new Pool({ connectionString: testContext.roleUrls.operations });
  const accounting = new Pool({ connectionString: testContext.roleUrls.accounting });
  const commands = new PostgresMutationCommandRepository(operations);
  const ledger = new PostgresVerificationLedgerRepository(operations);
  await commands.register(command, false);
  await ledger.transition({
    householdId: command.householdId,
    taskId: command.taskId,
    expectedFrom: 'checker_validated',
    to: 'execution_pending',
    reasonCode: 'test_execution_pending',
    responsibleComponent: 'RecoveryIntegrationTest',
  });
  await commands.markExecutionPending(command.householdId, command.commandId);
  const client = await accounting.connect();
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  const bridge = new PostgresDomainCommandBridge();
  await bridge.claim(client, command.householdId, command.commandId);
  const handler = createPostAccountingJournalHandler();
  const output = await handler.execute(client, PostJournalProposalSchemaV1.parse(command.payload), {
    householdId: command.householdId,
    taskId: command.taskId,
    commandId: command.commandId,
    checkedProposalId: command.checkedProposalId,
    checkedProposalHash: command.checkedProposalHash,
    idempotencyKey: command.idempotencyKey,
  });
  await bridge.commit(client, {
    householdId: command.householdId,
    commandId: command.commandId,
    receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    committedRecords: output.committedRecords,
    expectedState: output.expectedState,
    expectedStateHash: hashArtifact(output.expectedState),
  });
  await client.query('COMMIT');
  client.release();
  return {
    owner,
    accounting,
    operations,
    command,
    commands,
    ledger,
    close: async () => {
      await accounting.end();
      await operations.end();
      await owner.end();
    },
  };
}
