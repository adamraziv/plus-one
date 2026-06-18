// packages/accounting/src/repositories/ledger-readback.ts
import {
  AccountIdSchema, HouseholdIdSchema, JournalIdSchema, LocalDateSchema, PlusOneError,
  PostJournalInputSchemaV1, type PostJournalInputV1,
} from '@plus-one/contracts';
import type { PoolClient } from 'pg';
import { compareDecimalStrings } from '../amounts.js';

export interface PostedJournalReadback {
  householdId: string; bookId: string; journalId: string; periodId: string; draftId: string;
  taskId: string; checkedArtifactId: string; checkedArtifactHash: string;
  journalType: string; transactionCurrency: string; occurredOn: string; effectiveOn: string;
  settlementOn?: string; sourceOn?: string; description: string; counterpartyId?: string;
  reversesJournalId?: string; replacesJournalId?: string;
  tagIds: string[];
  postings: Array<{
    postingId: string; accountId: string; ordinal: number; direction: 'debit' | 'credit';
    transactionAmount: string; accountNativeAmount: string; accountNativeCurrency: string;
    exchangeRate?: string; exchangeRateQuote?: string; exchangeRateDate?: string;
    exchangeRateSource?: string; memo?: string; tagIds: string[];
  }>;
}

interface JournalRow {
  household_id: string; book_id: string; journal_id: string; period_id: string; draft_id: string;
  task_id: string; checked_artifact_id: string; checked_artifact_hash: string;
  journal_type: string; transaction_currency: string; occurred_on: string; effective_on: string;
  settlement_on: string | null; source_on: string | null; description: string;
  counterparty_id: string | null; reverses_journal_id: string | null;
  replaces_journal_id: string | null; tag_ids: string[];
}

interface PostingRow {
  posting_id: string; account_id: string; ordinal: number; direction: 'debit' | 'credit';
  transaction_amount: string; account_native_amount: string; account_native_currency: string;
  exchange_rate: string | null; exchange_rate_quote: string | null;
  exchange_rate_date: string | null; exchange_rate_source: string | null;
  memo: string | null; tag_ids: string[];
}

export class LedgerReadback {
  async readPostedJournal(client: Pick<PoolClient, 'query'>, householdId: string,
    journalId: string): Promise<PostedJournalReadback | undefined> {
    const journal = await client.query<JournalRow>(
      `SELECT household.household_id, book.book_id, journal.journal_id, period.period_id,
        draft.draft_id, journal.task_id, journal.checked_artifact_id,
        journal.checked_artifact_hash, journal.journal_type, journal.transaction_currency,
        journal.occurred_on::text, journal.effective_on::text, journal.settlement_on::text,
        journal.source_on::text, journal.description, counterparty.counterparty_id,
        reversed.journal_id AS reverses_journal_id, replaced.journal_id AS replaces_journal_id,
        ARRAY(SELECT tag.tag_id
          FROM accounting.journal_tags link
          JOIN accounting.tags tag ON tag.household_id = link.household_id AND tag.id = link.tag_id
          WHERE link.household_id = journal.household_id AND link.journal_id = journal.id
          ORDER BY tag.tag_id) AS tag_ids
       FROM accounting.journals journal
       JOIN operations.households household ON household.id = journal.household_id
       JOIN accounting.books book ON book.id = journal.book_id
       JOIN accounting.periods period ON period.id = journal.period_id
       JOIN accounting.journal_drafts draft ON draft.id = journal.draft_id
       LEFT JOIN accounting.counterparties counterparty ON counterparty.id = journal.counterparty_id
       LEFT JOIN accounting.journals reversed ON reversed.id = journal.reverses_journal_id
       LEFT JOIN accounting.journals replaced ON replaced.id = journal.replaces_journal_id
       WHERE household.household_id = $1 AND journal.journal_id = $2`,
      [HouseholdIdSchema.parse(householdId), JournalIdSchema.parse(journalId)],
    );
    const row = journal.rows[0];
    if (row === undefined) return undefined;
    const postings = await client.query<PostingRow>(
      `SELECT posting.posting_id, account.account_id, posting.ordinal, posting.direction,
        posting.transaction_amount::text, posting.account_native_amount::text,
        posting.account_native_currency, posting.exchange_rate::text,
        posting.exchange_rate_quote, posting.exchange_rate_date::text,
        posting.exchange_rate_source, posting.memo,
        coalesce(array_agg(tag.tag_id ORDER BY tag.tag_id)
          FILTER (WHERE tag.tag_id IS NOT NULL), '{}') AS tag_ids
       FROM accounting.postings posting
       JOIN accounting.accounts account ON account.id = posting.account_id
       LEFT JOIN accounting.posting_tags link
         ON link.household_id = posting.household_id AND link.posting_id = posting.id
       LEFT JOIN accounting.tags tag
         ON tag.household_id = link.household_id AND tag.id = link.tag_id
       WHERE posting.household_id = (
         SELECT id FROM operations.households WHERE household_id = $1
       ) AND posting.journal_id = (
         SELECT id FROM accounting.journals WHERE journal_id = $2
       )
       GROUP BY posting.id, account.account_id
       ORDER BY posting.ordinal`,
      [householdId, journalId],
    );
    return {
      householdId: row.household_id, bookId: row.book_id, journalId: row.journal_id,
      periodId: row.period_id, draftId: row.draft_id, taskId: row.task_id,
      checkedArtifactId: row.checked_artifact_id, checkedArtifactHash: row.checked_artifact_hash,
      journalType: row.journal_type, transactionCurrency: row.transaction_currency,
      occurredOn: row.occurred_on, effectiveOn: row.effective_on,
      ...(row.settlement_on === null ? {} : { settlementOn: row.settlement_on }),
      ...(row.source_on === null ? {} : { sourceOn: row.source_on }),
      description: row.description,
      ...(row.counterparty_id === null ? {} : { counterpartyId: row.counterparty_id }),
      ...(row.reverses_journal_id === null ? {} : { reversesJournalId: row.reverses_journal_id }),
      ...(row.replaces_journal_id === null ? {} : { replacesJournalId: row.replaces_journal_id }),
      tagIds: row.tag_ids,
      postings: postings.rows.map((posting) => ({
        postingId: posting.posting_id, accountId: posting.account_id,
        ordinal: posting.ordinal, direction: posting.direction,
        transactionAmount: posting.transaction_amount,
        accountNativeAmount: posting.account_native_amount,
        accountNativeCurrency: posting.account_native_currency,
        ...(posting.exchange_rate === null ? {} : { exchangeRate: posting.exchange_rate }),
        ...(posting.exchange_rate_quote === null ? {} : {
          exchangeRateQuote: posting.exchange_rate_quote,
        }),
        ...(posting.exchange_rate_date === null ? {} : {
          exchangeRateDate: posting.exchange_rate_date,
        }),
        ...(posting.exchange_rate_source === null ? {} : {
          exchangeRateSource: posting.exchange_rate_source,
        }),
        ...(posting.memo === null ? {} : { memo: posting.memo }),
        tagIds: posting.tag_ids,
      })),
    };
  }

  async accountNativeBalance(client: Pick<PoolClient, 'query'>, input: {
    householdId: string; accountId: string; asOf: string;
  }): Promise<{ currency: string; amount: string }> {
    const result = await client.query<{ currency: string; amount: string }>(
      `SELECT account.native_currency AS currency,
        coalesce(sum(CASE
          WHEN journal.id IS NULL THEN 0
          WHEN posting.direction = account.normal_balance THEN posting.account_native_amount
          ELSE -posting.account_native_amount END), 0)::text AS amount
       FROM accounting.accounts account
       LEFT JOIN accounting.postings posting
         ON posting.household_id = account.household_id AND posting.account_id = account.id
       LEFT JOIN accounting.journals journal
         ON journal.household_id = posting.household_id AND journal.id = posting.journal_id
        AND journal.effective_on <= $3::date
       WHERE account.household_id = (
         SELECT id FROM operations.households WHERE household_id = $1
       ) AND account.account_id = $2
       GROUP BY account.id`,
      [HouseholdIdSchema.parse(input.householdId), AccountIdSchema.parse(input.accountId),
        LocalDateSchema.parse(input.asOf)],
    );
    if (result.rows[0] === undefined) throw new PlusOneError({
      category: 'validation_rejected', code: 'account_not_found',
      message: 'Account was not found', retry: 'never',
      receiptLookupRequired: false, details: { accountId: input.accountId },
    });
    return result.rows[0];
  }

  async verifyPostedJournal(client: Pick<PoolClient, 'query'>, input: {
    householdId: string;
    expected: PostJournalInputV1;
  }): Promise<{ ok: boolean; journalId: string; mismatches: string[] }> {
    const expected = PostJournalInputSchemaV1.parse(input.expected);
    const actual = await this.readPostedJournal(client, input.householdId, expected.journalId);
    if (actual === undefined) return {
      ok: false, journalId: expected.journalId, mismatches: ['journal_missing'],
    };
    const mismatches: string[] = [];
    const topLevel: Array<[string, unknown, unknown]> = [
      ['book_id', actual.bookId, expected.bookId],
      ['period_id', actual.periodId, expected.periodId],
      ['draft_id', actual.draftId, expected.draftId],
      ['task_id', actual.taskId, expected.taskId],
      ['checked_artifact_id', actual.checkedArtifactId, expected.checkedArtifactId],
      ['checked_artifact_hash', actual.checkedArtifactHash, expected.checkedArtifactHash],
      ['journal_type', actual.journalType, expected.journalType],
      ['transaction_currency', actual.transactionCurrency, expected.transactionCurrency],
      ['occurred_on', actual.occurredOn, expected.occurredOn],
      ['effective_on', actual.effectiveOn, expected.effectiveOn],
      ['settlement_on', actual.settlementOn, expected.settlementOn],
      ['source_on', actual.sourceOn, expected.sourceOn],
      ['description', actual.description, expected.description],
      ['counterparty_id', actual.counterpartyId, expected.counterpartyId],
      ['reverses_journal_id', actual.reversesJournalId, expected.reversesJournalId],
      ['replaces_journal_id', actual.replacesJournalId, expected.replacesJournalId],
      ['tag_ids', actual.tagIds, [...expected.tagIds].sort()],
    ];
    for (const [field, observed, wanted] of topLevel) {
      if (JSON.stringify(observed) !== JSON.stringify(wanted)) mismatches.push(field);
    }
    if (actual.postings.length !== expected.postings.length) mismatches.push('posting_count');
    for (const [index, wanted] of expected.postings.entries()) {
      const observed = actual.postings[index];
      if (observed === undefined) continue;
      const prefix = 'postings[' + index + '].';
      for (const [field, left, right] of [
        ['account_id', observed.accountId, wanted.accountId],
        ['direction', observed.direction, wanted.direction],
        ['account_native_currency', observed.accountNativeCurrency, wanted.accountNativeCurrency],
        ['exchange_rate_quote', observed.exchangeRateQuote, wanted.exchangeRateQuote],
        ['exchange_rate_date', observed.exchangeRateDate, wanted.exchangeRateDate],
        ['exchange_rate_source', observed.exchangeRateSource, wanted.exchangeRateSource],
        ['memo', observed.memo, wanted.memo],
        ['tag_ids', observed.tagIds, [...wanted.tagIds].sort()],
      ] as const) {
        if (JSON.stringify(left) !== JSON.stringify(right)) mismatches.push(prefix + field);
      }
      if (compareDecimalStrings(observed.transactionAmount, wanted.transactionAmount) !== 0) {
        mismatches.push(prefix + 'transaction_amount');
      }
      if (compareDecimalStrings(observed.accountNativeAmount, wanted.accountNativeAmount) !== 0) {
        mismatches.push(prefix + 'account_native_amount');
      }
      if ((observed.exchangeRate === undefined) !== (wanted.exchangeRate === undefined)
        || (observed.exchangeRate !== undefined && wanted.exchangeRate !== undefined
          && compareDecimalStrings(observed.exchangeRate, wanted.exchangeRate) !== 0)) {
        mismatches.push(prefix + 'exchange_rate');
      }
    }
    return { ok: mismatches.length === 0, journalId: actual.journalId, mismatches };
  }
}
