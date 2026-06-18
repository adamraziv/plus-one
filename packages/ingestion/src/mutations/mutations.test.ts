import { describe, expect, it, vi } from 'vitest';
import { ConfirmImportBatchCommandAdapter } from './command-adapters.js';
import { createConfirmImportBatchHandler } from './import-handler.js';

const ids = {
  commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  artifactHash: 'a'.repeat(64),
  importBatchId: 'import_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  normalizedPost: 'normrow_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  normalizedLink: 'normrow_01JNZQ4A9B8C7D6E5F4G3H2J2K',
  normalizedDefer: 'normrow_01JNZQ4A9B8C7D6E5F4G3H2J3K',
  journalNew: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  journalExisting: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J2K',
};

describe('confirmed import mutation', () => {
  it('requires confirmation and preserves exact checked payload identity', () => {
    const adapter = new ConfirmImportBatchCommandAdapter();
    expect(() => adapter.buildCommand({
      commandId: ids.commandId,
      idempotencyKey: ids.idempotencyKey,
      householdId: ids.householdId,
      taskId: ids.taskId,
      checkedProposalId: ids.artifactId,
      checkedProposalHash: ids.artifactHash,
      payloadSchema: { schemaName: 'confirm-import-batch-proposal', schemaVersion: 1 },
      payload: {
        schemaName: 'confirm-import-batch-proposal',
        schemaVersion: 1,
        householdId: ids.householdId,
        importBatchId: ids.importBatchId,
        batchVersion: 1,
        decisions: [{ normalizedRowId: ids.normalizedDefer, action: 'defer', reasonCode: 'user_deferred' }],
      },
    })).toThrowError(/confirmation/i);
  });

  it('posts approved rows, links existing journals, and never posts deferred rows', async () => {
    const repository = {
      lockBatch: vi.fn().mockResolvedValue({
        state: 'awaiting_confirmation',
        batchVersion: 1,
        householdId: ids.householdId,
      }),
      insertRowDecision: vi.fn(),
      linkJournalSource: vi.fn(),
      transitionBatch: vi.fn(),
      readBatchOutcome: vi.fn().mockResolvedValue({
        state: 'partially_posted',
        posted: 1,
        linkedExisting: 1,
        deferred: 1,
        rejected: 0,
        allRowsBoundToCheckedArtifact: true,
      }),
    };
    const posting = { postInTransaction: vi.fn().mockResolvedValue({ journalId: ids.journalNew }) };
    const drafts = { insertVersion: vi.fn() };
    const handler = createConfirmImportBatchHandler({
      repository: repository as never,
      posting: posting as never,
      drafts: drafts as never,
    });
    const output = await handler.execute({} as never, importProposalFixture() as never, mutationContextFixture());
    expect(posting.postInTransaction).toHaveBeenCalledOnce();
    expect(repository.linkJournalSource).toHaveBeenCalledTimes(2);
    expect(output.committedRecords).toContainEqual({ recordType: 'import_batch', recordId: ids.importBatchId });
  });
});

function mutationContextFixture() {
  return {
    householdId: ids.householdId,
    taskId: ids.taskId,
    commandId: ids.commandId,
    checkedProposalId: ids.artifactId,
    checkedProposalHash: ids.artifactHash,
    idempotencyKey: ids.idempotencyKey,
  };
}

function importProposalFixture() {
  return {
    schemaName: 'confirm-import-batch-proposal' as const,
    schemaVersion: 1 as const,
    householdId: ids.householdId,
    importBatchId: ids.importBatchId,
    batchVersion: 1,
    decisions: [
      {
        normalizedRowId: ids.normalizedPost,
        action: 'post' as const,
        reasonCode: 'new_transaction',
        draft: {
          draftSeriesId: 'draftseries_01JNZQ4A9B8C7D6E5F4G3H2J1K',
          version: 1,
          journal: journalFixture(),
        },
      },
      {
        normalizedRowId: ids.normalizedLink,
        action: 'link_existing' as const,
        existingJournalId: ids.journalExisting,
        reasonCode: 'probable_duplicate_confirmed',
      },
      { normalizedRowId: ids.normalizedDefer, action: 'defer' as const, reasonCode: 'user_deferred' },
    ],
  };
}

function journalFixture() {
  return {
    schemaName: 'post-journal-proposal' as const,
    schemaVersion: 1 as const,
    householdId: ids.householdId,
    bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    journalId: ids.journalNew,
    draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    periodId: 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    taskId: ids.taskId,
    journalType: 'ordinary' as const,
    transactionCurrency: 'USD',
    occurredOn: '2026-05-01',
    effectiveOn: '2026-05-01',
    description: 'Imported Burger',
    postings: [
      {
        accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        direction: 'debit' as const,
        transactionAmount: '20.00',
        accountNativeAmount: '20.00',
        accountNativeCurrency: 'USD',
      },
      {
        accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
        direction: 'credit' as const,
        transactionAmount: '20.00',
        accountNativeAmount: '20.00',
        accountNativeCurrency: 'USD',
      },
    ],
  };
}
