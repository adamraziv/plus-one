import { describe, expect, it, vi } from 'vitest';
import {
  AccountIdSchema, DraftSeriesIdSchema, JournalDraftIdSchema, JournalIdSchema,
  PostJournalProposalSchemaV1,
} from '@plus-one/contracts';
import { createAccountingJournalMutationHandler } from './accounting-journal-handler.js';

const ids = {
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K' as const,
  bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' as const,
  journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K' as const,
  draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J1K' as const,
  periodId: 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K' as const,
  taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K' as const,
  draftSeriesId: 'draftseries_01JNZQ4A9B8C7D6E5F4G3H2J1K' as const,
  draftSeriesId2: 'draftseries_01JNZQ4A9B8C7D6E5F4G3H2J2K' as const,
  draftSeriesId3: 'draftseries_01JNZQ4A9B8C7D6E5F4G3H2J3K' as const,
  journalId2: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J2K' as const,
  journalId3: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J3K' as const,
  draftId2: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J2K' as const,
  draftId3: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J3K' as const,
  accountId1: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K' as const,
  accountId2: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K' as const,
  accountId3: 'account_01JNZQ4A9B8C7D6E5F4G3H2J3K' as const,
};

const baseJournal = PostJournalProposalSchemaV1.parse({
  schemaName: 'post-journal-proposal' as const, schemaVersion: 1 as const,
  householdId: ids.householdId, bookId: ids.bookId,
  journalId: ids.journalId, draftId: ids.draftId,
  periodId: ids.periodId, taskId: ids.taskId,
  journalType: 'ordinary', transactionCurrency: 'USD',
  occurredOn: '2026-06-15', effectiveOn: '2026-06-15',
  description: 'Lunch', tagIds: [],
  postings: [
    { accountId: ids.accountId1, direction: 'debit',
      transactionAmount: '20.00', accountNativeAmount: '20.00',
      accountNativeCurrency: 'USD', tagIds: [] },
    { accountId: ids.accountId2, direction: 'credit',
      transactionAmount: '20.00', accountNativeAmount: '20.00',
      accountNativeCurrency: 'USD', tagIds: [] },
  ],
});

function postProposal() {
  return {
    schemaName: 'accounting-journal-mutation-proposal' as const, schemaVersion: 1 as const,
    operation: 'post' as const,
    draft: {
      draftSeriesId: DraftSeriesIdSchema.parse(ids.draftSeriesId),
      version: 1 as const,
      journal: baseJournal,
    },
  };
}

describe('accounting journal mutation handler', () => {
  it('binds the exact checked artifact into the draft and posted journal', async () => {
    const drafts = { insertVersion: vi.fn() };
    const posting = { postInTransaction: vi.fn().mockResolvedValue({
      journalId: ids.journalId, postingIds: [],
    }) };
    const handler = createAccountingJournalMutationHandler({
      drafts: drafts as never, posting: posting as never,
      corrections: { reverseAndReplaceInTransaction: vi.fn() } as never,
      readback: { verifyPostedJournal: vi.fn(),
        accountNativeBalance: vi.fn().mockResolvedValue({ currency: 'USD', amount: '0.00' }) } as never,
    });
    await handler.execute({} as never, postProposal(), {
      householdId: ids.householdId, taskId: ids.taskId,
      commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      checkedProposalId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      checkedProposalHash: 'a'.repeat(64), idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
    });
    expect(drafts.insertVersion).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ checkedArtifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        checkedArtifactHash: 'a'.repeat(64) }));
    expect(posting.postInTransaction).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ checkedArtifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K' }));
  });

  it('inserts both checked drafts before one atomic reverse-and-replace call', async () => {
    const drafts = { insertVersion: vi.fn() };
    const corrections = { reverseAndReplaceInTransaction: vi.fn().mockResolvedValue({
      originalJournalId: ids.journalId,
      reversal: { journalId: ids.journalId2, postingIds: [] },
      replacement: { journalId: ids.journalId3, postingIds: [] },
    }) };
    const handler = createAccountingJournalMutationHandler({
      drafts: drafts as never, posting: { postInTransaction: vi.fn() } as never,
      corrections: corrections as never,
      readback: { verifyPostedJournal: vi.fn(),
        accountNativeBalance: vi.fn().mockResolvedValue({ currency: 'USD', amount: '0.00' }) } as never,
    });
    await handler.execute({} as never, {
      schemaName: 'accounting-journal-mutation-proposal' as const, schemaVersion: 1 as const,
      operation: 'reverse_replace' as const,
      originalJournalId: JournalIdSchema.parse(ids.journalId),
      reversal: {
        draftSeriesId: DraftSeriesIdSchema.parse(ids.draftSeriesId2), version: 1 as const,
        journal: { ...baseJournal, journalId: JournalIdSchema.parse(ids.journalId2),
          draftId: JournalDraftIdSchema.parse(ids.draftId2),
          journalType: 'reversal' as const, reversesJournalId: JournalIdSchema.parse(ids.journalId),
          postings: baseJournal.postings.map((entry) => ({
            ...entry,
            direction: entry.direction === 'debit' ? 'credit' as const : 'debit' as const,
          })) },
      },
      replacement: {
        draftSeriesId: DraftSeriesIdSchema.parse(ids.draftSeriesId3), version: 1 as const,
        journal: { ...baseJournal, journalId: JournalIdSchema.parse(ids.journalId3),
          draftId: JournalDraftIdSchema.parse(ids.draftId3),
          journalType: 'replacement' as const, replacesJournalId: JournalIdSchema.parse(ids.journalId),
          postings: baseJournal.postings.map((entry, index) => index === 0
            ? { ...entry, accountId: AccountIdSchema.parse(ids.accountId3) }
            : entry) },
      },
    }, { householdId: ids.householdId, taskId: ids.taskId,
      commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      checkedProposalId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      checkedProposalHash: 'a'.repeat(64), idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never });
    expect(drafts.insertVersion).toHaveBeenCalledTimes(2);
    expect(corrections.reverseAndReplaceInTransaction).toHaveBeenCalledOnce();
    expect(drafts.insertVersion.mock.invocationCallOrder[1]!)
      .toBeLessThan(corrections.reverseAndReplaceInTransaction.mock.invocationCallOrder[0]!);
  });

  it('rejects a clarification payload before reaching the mutation path', async () => {
    const drafts = { insertVersion: vi.fn() };
    const handler = createAccountingJournalMutationHandler({
      drafts: drafts as never, posting: { postInTransaction: vi.fn() } as never,
      corrections: { reverseAndReplaceInTransaction: vi.fn() } as never,
      readback: { verifyPostedJournal: vi.fn(),
        accountNativeBalance: vi.fn() } as never,
    });
    await expect(handler.execute({} as never, {
      schemaName: 'accounting-clarification' as const, schemaVersion: 1 as const,
      missingFields: ['payment_account'] as ['payment_account'],
      questions: ['Which account?'], reason: 'Required.',
    }, { householdId: ids.householdId, taskId: ids.taskId,
      commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      checkedProposalId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      checkedProposalHash: 'a'.repeat(64), idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never }))
      .rejects.toMatchObject({ code: 'accounting_clarification_not_executable' });
    expect(drafts.insertVersion).not.toHaveBeenCalled();
  });
});
