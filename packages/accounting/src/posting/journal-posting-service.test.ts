// packages/accounting/src/posting/journal-posting-service.test.ts
import { describe, expect, it } from 'vitest';
import type {
  AccountId, ArtifactId, BookId, CurrencyCode, DecimalString, HouseholdId,
  JournalDraftId, JournalId, LocalDate, PeriodId, TaskId,
} from '@plus-one/contracts';
import { JournalPostingService } from './journal-posting-service.js';

describe('JournalPostingService input boundary', () => {
  it('rejects prompted JSON and incomplete posted entries before SQL', async () => {
    const service = new JournalPostingService();
    await expect(service.postInTransaction({ query: async () => ({ rows: [] }) } as never,
      '{"journalType":"ordinary"}' as never)).rejects.toThrow();
    await expect(service.postInTransaction({ query: async () => ({ rows: [] }) } as never, {
      schemaName: 'post-journal-input', schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K' as HouseholdId,
      bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' as BookId,
      journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K' as JournalId,
      draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J1K' as JournalDraftId,
      periodId: 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K' as PeriodId,
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K' as TaskId,
      checkedArtifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K' as ArtifactId,
      checkedArtifactHash: 'a'.repeat(64), journalType: 'ordinary',
      transactionCurrency: 'USD' as CurrencyCode, occurredOn: '2026-06-14' as LocalDate,
      effectiveOn: '2026-06-14' as LocalDate,
      description: 'Missing second side', tagIds: [],
      postings: [{
        accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K' as AccountId,
        direction: 'debit', transactionAmount: '20.00' as DecimalString,
        accountNativeAmount: '20.00' as DecimalString,
        accountNativeCurrency: 'USD' as CurrencyCode, tagIds: [],
      }],
    })).rejects.toThrow();
  });
});
