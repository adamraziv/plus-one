import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  AccountingJournalCommandAdapter, AccountingJournalMutationProposalSchemaV1,
  createAccountingJournalMutationHandler,
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

describe('Accounting Team journal mutation', () => {
  it('inserts the immutable draft, posts once, and reaches readback_verified', async () => {
    context = await createPostgresTestContext('accounting_team_journal');
    owner = new Pool({ connectionString: context.migratorUrl });
    const fixture = await seedJournalPrerequisites(owner);
    const proposal = JSON.parse(JSON.stringify(fixture.proposal));
    const seeded = await seedAccountingProposal(owner, {
      householdId: fixture.householdId, taskId: fixture.taskId,
      artifactId: fixture.artifactId,
      outputSchema: { schemaName: 'accounting-journal-mutation-proposal', schemaVersion: 1 },
      proposal,
    });
    const command = new AccountingJournalCommandAdapter().buildCommand({
      commandId: fixture.commandId, idempotencyKey: fixture.idempotencyKey,
      householdId: fixture.householdId, taskId: fixture.taskId,
      checkedProposalId: fixture.artifactId, checkedProposalHash: seeded.artifactHash,
      payloadSchema: { schemaName: 'accounting-journal-mutation-proposal', schemaVersion: 1 },
      payload: proposal,
    });
    const harness = createExecutor(context, [createAccountingJournalMutationHandler()]);
    close = harness.close;
    await expect(harness.executor.execute(command)).resolves.toMatchObject({
      status: 'readback_verified', readback: { ok: true },
    });
    expect((await owner.query('SELECT count(*)::int AS count FROM accounting.journal_drafts')).rows[0])
      .toEqual({ count: 1 });
    expect((await owner.query('SELECT count(*)::int AS count FROM accounting.journals')).rows[0])
      .toEqual({ count: 1 });
  });
});

async function seedJournalPrerequisites(owner: Pool) {
  const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
  const bookId = 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K';
  const taskId = 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K';
  const artifactId = 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K';
  const household = await owner.query<{ id: string }>(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1,'USD','UTC') RETURNING id::text`, [householdId],
  );
  const book = await owner.query<{ id: string }>(
    `INSERT INTO accounting.books (book_id, household_id, name)
     VALUES ($1,$2,'Household Book') RETURNING id::text`, [bookId, household.rows[0]!.id],
  );
  await owner.query(
    `INSERT INTO accounting.book_configurations
     (configuration_id, household_id, book_id, reporting_currency, effective_from)
     VALUES ('bookconfig_01JNZQ4A9B8C7D6E5F4G3H2J1K',$1,$2,'USD',DATE '2026-01-01')`,
    [household.rows[0]!.id, book.rows[0]!.id],
  );
  await owner.query(
    `INSERT INTO accounting.periods
     (period_id, household_id, book_id, period_start, period_end)
     VALUES ('period_01JNZQ4A9B8C7D6E5F4G3H2J1K',$1,$2,DATE '2026-06-01',DATE '2026-06-30')`,
    [household.rows[0]!.id, book.rows[0]!.id],
  );
  await owner.query(
    `INSERT INTO accounting.accounts
     (account_id, household_id, book_id, name, accounting_class, normal_balance, native_currency)
     VALUES
     ('account_01JNZQ4A9B8C7D6E5F4G3H2J1K',$1,$2,'Food','expense','debit','USD'),
     ('account_01JNZQ4A9B8C7D6E5F4G3H2J2K',$1,$2,'Cash','asset','debit','USD')`,
    [household.rows[0]!.id, book.rows[0]!.id],
  );
  const proposal = AccountingJournalMutationProposalSchemaV1.parse({
    schemaName: 'accounting-journal-mutation-proposal', schemaVersion: 1,
    operation: 'post', draft: {
      draftSeriesId: 'draftseries_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never, version: 1 as never,
      journal: {
        schemaName: 'post-journal-proposal' as const, schemaVersion: 1 as const,
        householdId, bookId, journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
        draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
        periodId: 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never, taskId: taskId as never,
        journalType: 'ordinary' as const, transactionCurrency: 'USD' as never,
        occurredOn: '2026-06-15', effectiveOn: '2026-06-15',
        description: 'Lunch', tagIds: [] as never,
        postings: [
          { accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never, direction: 'debit' as const,
            transactionAmount: '20.00' as never, accountNativeAmount: '20.00' as never,
            accountNativeCurrency: 'USD' as never, tagIds: [] as never },
          { accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K' as never, direction: 'credit' as const,
            transactionAmount: '20.00' as never, accountNativeAmount: '20.00' as never,
            accountNativeCurrency: 'USD' as never, tagIds: [] as never },
        ],
      },
    },
  });
  return { householdId, bookId, taskId, artifactId, proposal,
    commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
    idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never };
}
