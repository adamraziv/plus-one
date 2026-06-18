import { describe, expect, it } from 'vitest';
import {
  AccountSourceMappingIdSchema, JournalDraftInputSchemaV1,
  PostJournalInputSchemaV1, PostJournalProposalSchemaV1,
  ReverseAndReplaceInputSchemaV1,
} from './index.js';

const posting = {
  accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  direction: 'debit',
  transactionAmount: '20.00',
  accountNativeAmount: '20.00',
  accountNativeCurrency: 'USD',
};

describe('accounting contracts', () => {
  it('uses an opaque source-mapping identity for chart changes', () => {
    expect(AccountSourceMappingIdSchema.parse(
      'accountmap_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    )).toBe('accountmap_01JNZQ4A9B8C7D6E5F4G3H2J1K');
  });

  it('allows zero draft postings but rejects non-positive posted amounts', () => {
    expect(JournalDraftInputSchemaV1.parse({
      schemaName: 'journal-draft-input', schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      draftSeriesId: 'draftseries_01JNZQ4A9B8C7D6E5F4G3H2J1K', version: 1,
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      checkedArtifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      checkedArtifactHash: 'a'.repeat(64), journalType: 'ordinary',
      transactionCurrency: 'USD', occurredOn: '2026-06-14', effectiveOn: '2026-06-14',
      description: 'Incomplete draft',
      postings: [{ ...posting, transactionAmount: '0', accountNativeAmount: '0' }],
    }).postings[0]?.transactionAmount).toBe('0');

    expect(PostJournalInputSchemaV1.safeParse({
      schemaName: 'post-journal-input', schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      periodId: 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      checkedArtifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      checkedArtifactHash: 'a'.repeat(64), journalType: 'ordinary',
      transactionCurrency: 'USD', occurredOn: '2026-06-14', effectiveOn: '2026-06-14',
      description: 'Invalid zero posting',
      postings: [posting, { ...posting, direction: 'credit', transactionAmount: '0' }],
    }).success).toBe(false);
  });

  it('requires complete rate provenance for cross-currency postings', () => {
    const base = {
      schemaName: 'post-journal-input', schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      periodId: 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      checkedArtifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      checkedArtifactHash: 'a'.repeat(64), journalType: 'ordinary',
      transactionCurrency: 'USD', occurredOn: '2026-06-14', effectiveOn: '2026-06-14',
      description: 'Cross currency', postings: [
        { ...posting, accountNativeCurrency: 'EUR', accountNativeAmount: '18.40' },
        { ...posting, direction: 'credit' },
      ],
    };
    expect(PostJournalInputSchemaV1.safeParse(base).success).toBe(false);
    const valid = {
      ...base, postings: [{ ...base.postings[0], exchangeRate: '0.92',
        exchangeRateQuote: 'native_per_transaction', exchangeRateDate: '2026-06-14',
        exchangeRateSource: 'user-confirmed' }, base.postings[1]],
    };
    expect(PostJournalInputSchemaV1.parse(valid).postings[0]?.exchangeRate).toBe('0.92');
    const { checkedArtifactId: _artifactId, checkedArtifactHash: _artifactHash,
      schemaName: _schemaName, ...proposal } = valid;
    void _artifactId; void _artifactHash; void _schemaName;
    expect(PostJournalProposalSchemaV1.parse({
      ...proposal, schemaName: 'post-journal-proposal',
    })).not.toHaveProperty('checkedArtifactHash');
  });

  it('requires separate reversal and replacement journal identities', () => {
    expect(ReverseAndReplaceInputSchemaV1.safeParse({
      originalJournalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      reversal: { journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J2K' },
      replacement: { journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J2K' },
    }).success).toBe(false);
  });
});
