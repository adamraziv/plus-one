import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  ChartOfAccountsCommandAdapter, createChartOfAccountsMutationHandler,
} from '@plus-one/accounting';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';
import { seedAccountingProposal } from '../helpers/accounting-team.js';
import { createExecutor } from '../helpers/checked-mutation.js';

let context: PostgresTestContext | undefined;
let close: (() => Promise<void>) | undefined;
let owner: Pool | undefined;
afterEach(async () => {
  await owner?.end();
  await close?.();
  await context?.cleanup();
  close = undefined; context = undefined; owner = undefined;
});

describe('Accounting Team chart mutation', () => {
  it('requires exact confirmations and creates one source-mapped account', async () => {
    context = await createPostgresTestContext('accounting_team_chart');
    owner = new Pool({ connectionString: context.migratorUrl });
    const ids = await seedBook(owner);
    const proposal = {
      schemaName: 'chart-of-accounts-proposal' as const, schemaVersion: 1 as const,
      action: 'create_account' as const,
      householdId: ids.householdId, bookId: ids.bookId, accountId: ids.accountId,
      name: 'Checking', accountingClass: 'asset' as const,
      normalBalance: 'debit' as const, nativeCurrency: 'USD' as never,
    };
    const confirmed = await seedAccountingProposal(owner, {
      householdId: ids.householdId, taskId: ids.taskId, artifactId: ids.artifactId,
      outputSchema: { schemaName: 'chart-of-accounts-proposal', schemaVersion: 1 },
      proposal, confirmationId: ids.confirmationId,
    });
    const command = new ChartOfAccountsCommandAdapter().buildCommand({
      commandId: ids.commandId, idempotencyKey: ids.idempotencyKey,
      confirmationId: ids.confirmationId, householdId: ids.householdId,
      taskId: ids.taskId, checkedProposalId: ids.artifactId,
      checkedProposalHash: confirmed.artifactHash,
      payloadSchema: { schemaName: 'chart-of-accounts-proposal', schemaVersion: 1 },
      payload: proposal,
    });
    const harness = createExecutor(context, [createChartOfAccountsMutationHandler()]);
    close = harness.close;
    await expect(harness.executor.execute(command)).resolves.toMatchObject({
      status: 'readback_verified', readback: { ok: true },
    });
    expect((await owner.query(
      `SELECT name, accounting_class, native_currency FROM accounting.accounts
       WHERE account_id = $1`, [ids.accountId],
    )).rows[0]).toEqual({ name: 'Checking', accounting_class: 'asset', native_currency: 'USD' });
  });

  it('creates no account when the referenced confirmation observation is absent', async () => {
    context = await createPostgresTestContext('accounting_team_chart_unconfirmed');
    owner = new Pool({ connectionString: context.migratorUrl });
    const ids = await seedBook(owner);
    const proposal = {
      schemaName: 'chart-of-accounts-proposal' as const, schemaVersion: 1 as const,
      action: 'create_account' as const,
      householdId: ids.householdId, bookId: ids.bookId, accountId: ids.accountId,
      name: 'Checking', accountingClass: 'asset' as const,
      normalBalance: 'debit' as const, nativeCurrency: 'USD' as never,
    };
    const seeded = await seedAccountingProposal(owner, {
      householdId: ids.householdId, taskId: ids.taskId, artifactId: ids.artifactId,
      outputSchema: { schemaName: 'chart-of-accounts-proposal', schemaVersion: 1 },
      proposal,
    });
    const command = new ChartOfAccountsCommandAdapter().buildCommand({
      commandId: ids.commandId, idempotencyKey: ids.idempotencyKey,
      confirmationId: ids.confirmationId, householdId: ids.householdId,
      taskId: ids.taskId, checkedProposalId: ids.artifactId,
      checkedProposalHash: seeded.artifactHash,
      payloadSchema: { schemaName: 'chart-of-accounts-proposal', schemaVersion: 1 },
      payload: proposal,
    });
    const harness = createExecutor(context, [createChartOfAccountsMutationHandler()]);
    close = harness.close;
    await expect(harness.executor.execute(command)).rejects.toMatchObject({
      code: 'exact_external_confirmation_required',
    });
    expect((await owner.query(
      'SELECT count(*)::int AS count FROM accounting.accounts WHERE account_id = $1',
      [ids.accountId],
    )).rows[0]).toEqual({ count: 0 });
  });
});

async function seedBook(owner: Pool) {
  const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
  const bookId = 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K';
  const household = await owner.query<{ id: string }>(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1,'USD','UTC') RETURNING id::text`, [householdId],
  );
  await owner.query(
    `INSERT INTO accounting.books (book_id, household_id, name)
     VALUES ($1,$2,'Household Book')`, [bookId, household.rows[0]!.id],
  );
  return {
    householdId, bookId,
    taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
    artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
    accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
    confirmationId: 'confirm_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
    commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
    idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
  };
}
