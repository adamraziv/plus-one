// packages/accounting/src/posting/corrections.test.ts
import { describe, expect, it, vi } from 'vitest';
import type {
  AccountId, BookId, CurrencyCode, DecimalString, HouseholdId,
  JournalDraftId, JournalId, LocalDate, PeriodId, TaskId, ArtifactId,
} from '@plus-one/contracts';
import { CorrectionService, buildExactReversalPostings } from './corrections.js';

describe('accounting corrections', () => {
  it('builds exact opposite postings while preserving native and FX evidence', () => {
    expect(buildExactReversalPostings([
      { accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K' as AccountId, direction: 'debit',
        transactionAmount: '20.00' as DecimalString, accountNativeAmount: '18.40' as DecimalString,
        accountNativeCurrency: 'EUR' as CurrencyCode, exchangeRate: '0.92' as DecimalString,
        exchangeRateQuote: 'native_per_transaction' as const, exchangeRateDate: '2026-06-14' as LocalDate,
        exchangeRateSource: 'user-confirmed', tagIds: [] },
      { accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K' as AccountId, direction: 'credit',
        transactionAmount: '20.00' as DecimalString, accountNativeAmount: '20.00' as DecimalString,
        accountNativeCurrency: 'USD' as CurrencyCode, tagIds: [] },
    ], (index) => index === 0
      ? 'posting_01JNZQ4A9B8C7D6E5F4G3H2J3K'
      : 'posting_01JNZQ4A9B8C7D6E5F4G3H2J4K')).toEqual([
      expect.objectContaining({ direction: 'credit', transactionAmount: '20.00',
        accountNativeAmount: '18.40', exchangeRate: '0.92' }),
      expect.objectContaining({ direction: 'debit', transactionAmount: '20.00',
        accountNativeAmount: '20.00' }),
    ]);
  });

  it('posts reversal before replacement in one caller-owned transaction', async () => {
    const postInTransaction = vi.fn()
      .mockResolvedValueOnce({ journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J2K' as JournalId, postingIds: [] })
      .mockResolvedValueOnce({ journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J3K' as JournalId, postingIds: [] });
    const service = new CorrectionService({ postInTransaction });
    await service.reverseAndReplaceInTransaction({
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ transaction_isolation: 'serializable',
          transaction_read_only: 'off' }] })
        .mockResolvedValueOnce({ rows: [{ journal_id: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K' }] }),
    } as never, correctionInput());
    expect(postInTransaction.mock.calls.map((call) => call[1].journalType))
      .toEqual(['reversal', 'replacement']);
  });
});

function correctionInput() {
  const common = {
    schemaName: 'post-journal-input' as const, schemaVersion: 1 as const,
    householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K' as HouseholdId,
    bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' as BookId,
    periodId: 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K' as PeriodId,
    taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K' as TaskId,
    checkedArtifactHash: 'a'.repeat(64), transactionCurrency: 'USD' as CurrencyCode,
    occurredOn: '2026-06-15' as LocalDate, effectiveOn: '2026-06-15' as LocalDate, tagIds: [],
  };
  const post = (accountPublic: string, direction: 'debit' | 'credit', amount: string) => ({
    accountId: accountPublic as AccountId, direction,
    transactionAmount: amount as DecimalString, accountNativeAmount: amount as DecimalString,
    accountNativeCurrency: 'USD' as CurrencyCode, tagIds: [] as never[],
  });
  return {
    originalJournalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K' as JournalId,
    reversal: {
      ...common, journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J2K' as JournalId,
      draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J2K' as JournalDraftId,
      checkedArtifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K' as ArtifactId,
      journalType: 'reversal' as const,
      reversesJournalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K' as JournalId,
      description: 'Reverse original',
      postings: [
        post('account_01JNZQ4A9B8C7D6E5F4G3H2J1K', 'credit', '20.00'),
        post('account_01JNZQ4A9B8C7D6E5F4G3H2J2K', 'debit', '20.00'),
      ],
    },
    replacement: {
      ...common, journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J3K' as JournalId,
      draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J3K' as JournalDraftId,
      checkedArtifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J3K' as ArtifactId,
      journalType: 'replacement' as const,
      replacesJournalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K' as JournalId,
      description: 'Corrected original',
      postings: [
        post('account_01JNZQ4A9B8C7D6E5F4G3H2J1K', 'debit', '25.00'),
        post('account_01JNZQ4A9B8C7D6E5F4G3H2J2K', 'credit', '25.00'),
      ],
    },
  };
}
