import { describe, expect, it } from 'vitest';
import {
  AccountingClarificationSchemaV1,
  AccountingJournalMutationProposalSchemaV1,
  AccountingWorkResultSchemaV1,
  ChartOfAccountsProposalSchemaV1,
  ChartWorkRequestSchemaV1,
  ChartWorkResultSchemaV1,
} from './contracts.js';

const baseJournal = {
  schemaName: 'post-journal-proposal' as const,
  schemaVersion: 1 as const,
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  periodId: 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  journalType: 'ordinary' as const,
  transactionCurrency: 'USD',
  occurredOn: '2026-06-15',
  effectiveOn: '2026-06-15',
  description: 'Lunch',
  tagIds: [],
  postings: [
    {
      accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      direction: 'debit' as const,
      transactionAmount: '20.00',
      accountNativeAmount: '20.00',
      accountNativeCurrency: 'USD',
      tagIds: [],
    },
    {
      accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
      direction: 'credit' as const,
      transactionAmount: '20.00',
      accountNativeAmount: '20.00',
      accountNativeCurrency: 'USD',
      tagIds: [],
    },
  ],
};

describe('accounting workflow contracts', () => {
  it('accepts a self-hash-free checked draft proposal', () => {
    const result = AccountingJournalMutationProposalSchemaV1.parse({
      schemaName: 'accounting-journal-mutation-proposal',
      schemaVersion: 1,
      operation: 'post',
      draft: {
        draftSeriesId: 'draftseries_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        version: 1,
        journal: baseJournal,
      },
    });
    expect(result).not.toHaveProperty('checkedArtifactHash');
  });

  it('keeps clarification separate from executable proposals', () => {
    const clarification = AccountingClarificationSchemaV1.parse({
      schemaName: 'accounting-clarification',
      schemaVersion: 1,
      missingFields: ['payment_account'],
      questions: ['Which account paid for this transaction?'],
      reason: 'Payment account materially changes the credit posting.',
    });
    const workResult = AccountingWorkResultSchemaV1.parse(clarification);
    if (workResult.schemaName !== 'accounting-clarification') throw new Error('expected clarification');
    expect(workResult.missingFields).toEqual(['payment_account']);
    expect(AccountingJournalMutationProposalSchemaV1.safeParse(clarification).success).toBe(false);
  });

  it('rejects correction proposals missing the reversal/replacement linkage', () => {
    expect(AccountingJournalMutationProposalSchemaV1.safeParse({
      schemaName: 'accounting-journal-mutation-proposal',
      schemaVersion: 1,
      operation: 'reverse_replace',
      originalJournalId: baseJournal.journalId,
      reversal: {
        draftSeriesId: 'draftseries_01JNZQ4A9B8C7D6E5F4G3H2J2K',
        version: 1,
        journal: {
          ...baseJournal,
          journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          journalType: 'reversal',
        },
      },
      replacement: {
        draftSeriesId: 'draftseries_01JNZQ4A9B8C7D6E5F4G3H2J3K',
        version: 1,
        journal: {
          ...baseJournal,
          journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J3K',
          draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J3K',
          journalType: 'replacement',
        },
      },
    }).success).toBe(false);
  });

  it('accepts a fully linked reverse-and-replace proposal', () => {
    const original = baseJournal.journalId;
    const result = AccountingJournalMutationProposalSchemaV1.parse({
      schemaName: 'accounting-journal-mutation-proposal',
      schemaVersion: 1,
      operation: 'reverse_replace',
      originalJournalId: original,
      reversal: {
        draftSeriesId: 'draftseries_01JNZQ4A9B8C7D6E5F4G3H2J2K',
        version: 1,
        journal: {
          ...baseJournal,
          journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          journalType: 'reversal',
          reversesJournalId: original,
        },
      },
      replacement: {
        draftSeriesId: 'draftseries_01JNZQ4A9B8C7D6E5F4G3H2J3K',
        version: 1,
        journal: {
          ...baseJournal,
          journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J3K',
          draftId: 'draft_01JNZQ4A9B8C7D6E5F4G3H2J3K',
          journalType: 'replacement',
          replacesJournalId: original,
        },
      },
    });
    expect(result.operation).toBe('reverse_replace');
  });

  it('requires typed chart action payloads', () => {
    expect(ChartOfAccountsProposalSchemaV1.parse({
      schemaName: 'chart-of-accounts-proposal',
      schemaVersion: 1,
      action: 'create_source_mapping',
      householdId: baseJournal.householdId,
      bookId: baseJournal.bookId,
      mappingId: 'accountmap_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      accountId: baseJournal.postings[0]!.accountId,
      sourceSystem: 'bank-feed',
      externalAccountId: 'checking-1',
      metadata: { label: 'Checking' },
    }).action).toBe('create_source_mapping');
  });

  it('requires action-correlated chart identities', () => {
    const base = {
      schemaName: 'chart-work-request' as const,
      schemaVersion: 1 as const,
      householdId: baseJournal.householdId,
      bookId: baseJournal.bookId,
      instruction: 'Create a household bank account.',
      known: {},
    };

    expect(ChartWorkRequestSchemaV1.safeParse({
      ...base,
      action: 'update_account',
    }).success).toBe(false);
    expect(ChartWorkRequestSchemaV1.safeParse({
      ...base,
      action: 'archive_account',
    }).success).toBe(false);
    expect(ChartWorkRequestSchemaV1.safeParse({
      ...base,
      action: 'create_source_mapping',
      mappingId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      accountId: baseJournal.postings[0]!.accountId,
    }).success).toBe(false);
    expect(ChartWorkRequestSchemaV1.safeParse({
      ...base,
      action: 'replace_source_mapping',
      mappingId: 'accountmap_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      accountId: baseJournal.postings[0]!.accountId,
    }).success).toBe(false);
  });

  it('keeps chart clarification separate from executable chart proposals', () => {
    const clarification = ChartWorkResultSchemaV1.parse({
      schemaName: 'chart-clarification',
      schemaVersion: 1,
      missingFields: ['name', 'accounting_class', 'native_currency'],
      questions: ['What is the account name?', 'Which accounting class applies?', 'What is the currency?'],
      reason: 'The requested account lacks required user-owned fields.',
    });
    expect(clarification.schemaName).toBe('chart-clarification');
    expect(ChartOfAccountsProposalSchemaV1.safeParse(clarification).success).toBe(false);
  });
});
