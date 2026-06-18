// packages/accounting/src/repositories/ledger-readback.test.ts
import { describe, expect, it, vi } from 'vitest';
import type {
  AccountId, ArtifactId, BookId, CurrencyCode, DecimalString, HouseholdId,
  JournalDraftId, JournalId, LocalDate, PeriodId, TaskId,
} from '@plus-one/contracts';
import { LedgerReadback } from './ledger-readback.js';

describe('LedgerReadback', () => {
  it('returns typed read-back mismatch details without exposing SQL', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        household_id: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        book_id: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        journal_id: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        period_id: 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        draft_id: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        task_id: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        checked_artifact_id: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        checked_artifact_hash: 'a'.repeat(64), journal_type: 'ordinary',
        transaction_currency: 'USD', occurred_on: '2026-06-14',
        effective_on: '2026-06-14', settlement_on: null, source_on: null,
        description: 'Burger', counterparty_id: null,
        reverses_journal_id: null, replaces_journal_id: null, tag_ids: [],
      }] })
      .mockResolvedValueOnce({ rows: [
        { posting_id: 'posting_01JNZQ4A9B8C7D6E5F4G3H2J1K',
          account_id: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K', ordinal: 1,
          direction: 'debit', transaction_amount: '20.000000000000',
          account_native_amount: '20.000000000000', account_native_currency: 'USD',
          exchange_rate: null, exchange_rate_quote: null, exchange_rate_date: null,
          exchange_rate_source: null, memo: null, tag_ids: [] },
        { posting_id: 'posting_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          account_id: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K', ordinal: 2,
          direction: 'credit', transaction_amount: '20.000000000000',
          account_native_amount: '20.000000000000', account_native_currency: 'USD',
          exchange_rate: null, exchange_rate_quote: null, exchange_rate_date: null,
          exchange_rate_source: null, memo: null, tag_ids: [] },
      ] });
    const readback = new LedgerReadback();
    const result = await readback.verifyPostedJournal({ query } as never, {
      expected: {
        schemaName: 'post-journal-input', schemaVersion: 1,
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K' as HouseholdId,
        bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' as BookId,
        journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K' as JournalId,
        periodId: 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K' as PeriodId,
        draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J1K' as JournalDraftId,
        taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K' as TaskId,
        checkedArtifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K' as ArtifactId,
        checkedArtifactHash: 'b'.repeat(64), journalType: 'ordinary',
        transactionCurrency: 'USD' as CurrencyCode, occurredOn: '2026-06-14' as LocalDate,
        effectiveOn: '2026-06-14' as LocalDate, description: 'Burger', tagIds: [],
        postings: [
          { accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K' as AccountId,
            direction: 'debit' as const,
            transactionAmount: '20.00' as DecimalString, accountNativeAmount: '20.00' as DecimalString,
            accountNativeCurrency: 'USD' as CurrencyCode, tagIds: [] },
          { accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K' as AccountId,
            direction: 'credit' as const,
            transactionAmount: '20.00' as DecimalString, accountNativeAmount: '20.00' as DecimalString,
            accountNativeCurrency: 'USD' as CurrencyCode, tagIds: [] },
        ],
      },
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K' as HouseholdId,
    });
    expect(result).toEqual({
      ok: false,
      journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      mismatches: ['checked_artifact_hash'],
    });
  });
});
