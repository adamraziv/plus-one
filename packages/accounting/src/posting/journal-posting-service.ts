// packages/accounting/src/posting/journal-posting-service.ts
import { randomBytes } from 'node:crypto';
import {
  AccountIdSchema, PostingIdSchema, PlusOneError, PostJournalInputSchemaV1, TagIdSchema,
  type PostJournalInputV1,
} from '@plus-one/contracts';
import type { PoolClient } from 'pg';
import { normalizeAccountingError } from '../errors.js';
import { assertSerializableTransaction } from '../transactions.js';
import type { CurrentBalanceProjectionHook } from './projection-hook.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulidLike26(): string {
  const bytes = randomBytes(20);
  let result = '';
  for (let i = 0; i < 26; i++) {
    const byte = bytes[Math.floor(i / 2)] ?? 0;
    const nibble = i % 2 === 0 ? (byte >> 4) & 0x0f : byte & 0x0f;
    result += CROCKFORD[nibble & 0x1f] ?? '0';
  }
  return result;
}

function newPostingId(): string {
  return 'posting_' + ulidLike26();
}

interface ResolvedJournal {
  household_id: string; book_id: string; period_id: string; draft_id: string;
  counterparty_id: string | null; reverses_journal_id: string | null;
  replaces_journal_id: string | null;
}

function referenceError(code: string, message: string, details: Record<string, string | number | boolean | null>): PlusOneError {
  return new PlusOneError({
    category: 'validation_rejected', code, message, retry: 'never',
    receiptLookupRequired: false, details,
  });
}

export class JournalPostingService {
  constructor(private readonly projection?: CurrentBalanceProjectionHook) {}

  async postInTransaction(client: PoolClient, candidate: PostJournalInputV1): Promise<{
    journalId: string; postingIds: string[];
  }> {
    const input = PostJournalInputSchemaV1.parse(candidate);
    await assertSerializableTransaction(client);
    try {
      const resolved = await this.resolveJournal(client, input);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO accounting.journals
         (journal_id, household_id, book_id, period_id, draft_id, task_id,
          checked_artifact_id, checked_artifact_hash, journal_type, transaction_currency,
          occurred_on, effective_on, settlement_on, source_on, description, counterparty_id,
          reverses_journal_id, replaces_journal_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING id::text`,
        [input.journalId, resolved.household_id, resolved.book_id, resolved.period_id,
          resolved.draft_id, input.taskId, input.checkedArtifactId, input.checkedArtifactHash,
          input.journalType, input.transactionCurrency, input.occurredOn, input.effectiveOn,
          input.settlementOn ?? null, input.sourceOn ?? null, input.description,
          resolved.counterparty_id, resolved.reverses_journal_id, resolved.replaces_journal_id],
      );
      const journalDbId = inserted.rows[0]!.id;
      const accounts = await this.resolveAccounts(client, resolved.household_id,
        input.postings.map((posting) => posting.accountId));
      const postingIds: string[] = [];
      for (const [index, posting] of input.postings.entries()) {
        const postingId = PostingIdSchema.parse(newPostingId());
        const row = await client.query<{ id: string }>(
          `INSERT INTO accounting.postings
           (posting_id, household_id, journal_id, ordinal, account_id, direction,
            transaction_amount, account_native_amount, account_native_currency,
            exchange_rate, exchange_rate_quote, exchange_rate_date, exchange_rate_source, memo)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           RETURNING id::text`,
          [postingId, resolved.household_id, journalDbId, index + 1,
            accounts.get(posting.accountId)!, posting.direction, posting.transactionAmount,
            posting.accountNativeAmount, posting.accountNativeCurrency,
            posting.exchangeRate ?? null, posting.exchangeRateQuote ?? null,
            posting.exchangeRateDate ?? null, posting.exchangeRateSource ?? null,
            posting.memo ?? null],
        );
        await this.insertPostingTags(client, resolved.household_id, row.rows[0]!.id, posting.tagIds);
        postingIds.push(postingId);
      }
      await this.insertJournalTags(client, resolved.household_id, journalDbId, input.tagIds);
      await this.updateCurrentProjection(client, input, postingIds);
      await client.query(
        'SET CONSTRAINTS journals_validate_complete, postings_validate_complete IMMEDIATE',
      );
      await client.query(
        'SET CONSTRAINTS journals_validate_complete, postings_validate_complete DEFERRED',
      );
      return { journalId: input.journalId, postingIds };
    } catch (error) { throw normalizeAccountingError(error); }
  }

  private async updateCurrentProjection(client: PoolClient, input: PostJournalInputV1,
    postingIds: readonly string[]): Promise<void> {
    await this.projection?.applyJournal(client, {
      householdId: input.householdId,
      journalId: input.journalId,
      postingIds: [...postingIds],
      effectiveOn: input.effectiveOn,
    });
  }

  private async resolveJournal(client: PoolClient, input: PostJournalInputV1): Promise<ResolvedJournal> {
    const result = await client.query<ResolvedJournal>(
      `SELECT household.id::text AS household_id, book.id::text AS book_id,
        period.id::text AS period_id, draft.id::text AS draft_id,
        counterparty.id::text AS counterparty_id,
        reversed.id::text AS reverses_journal_id,
        replaced.id::text AS replaces_journal_id
       FROM operations.households household
       JOIN accounting.books book ON book.household_id = household.id AND book.book_id = $2
       JOIN accounting.periods period
         ON period.household_id = household.id AND period.book_id = book.id AND period.period_id = $3
       JOIN accounting.journal_drafts draft
         ON draft.household_id = household.id AND draft.book_id = book.id AND draft.draft_id = $4
        AND draft.task_id = $5 AND draft.checked_artifact_id = $6 AND draft.checked_artifact_hash = $7
       LEFT JOIN accounting.counterparties counterparty
         ON counterparty.household_id = household.id AND counterparty.counterparty_id = $8
       LEFT JOIN accounting.journals reversed
         ON reversed.household_id = household.id AND reversed.journal_id = $9
       LEFT JOIN accounting.journals replaced
         ON replaced.household_id = household.id AND replaced.journal_id = $10
       WHERE household.household_id = $1`,
      [input.householdId, input.bookId, input.periodId, input.draftId, input.taskId,
        input.checkedArtifactId, input.checkedArtifactHash, input.counterpartyId ?? null,
        input.reversesJournalId ?? null, input.replacesJournalId ?? null],
    );
    if (result.rows[0] === undefined) throw referenceError(
      'journal_reference_not_found', 'Journal references were not found',
      { journalId: input.journalId, draftId: input.draftId },
    );
    if (input.counterpartyId !== undefined && result.rows[0].counterparty_id === null) {
      throw referenceError('counterparty_not_found', 'Counterparty was not found',
        { counterpartyId: input.counterpartyId });
    }
    if (input.reversesJournalId !== undefined && result.rows[0].reverses_journal_id === null) {
      throw referenceError('reversed_journal_not_found', 'Reversed journal was not found',
        { journalId: input.reversesJournalId });
    }
    if (input.replacesJournalId !== undefined && result.rows[0].replaces_journal_id === null) {
      throw referenceError('replaced_journal_not_found', 'Replaced journal was not found',
        { journalId: input.replacesJournalId });
    }
    return result.rows[0];
  }

  private async resolveAccounts(client: PoolClient, householdDbId: string,
    accountIds: readonly string[]): Promise<Map<string, string>> {
    const parsed = accountIds.map((accountId) => AccountIdSchema.parse(accountId));
    const result = await client.query<{ account_id: string; id: string }>(
      `SELECT account_id, id::text FROM accounting.accounts
       WHERE household_id = $1 AND account_id = ANY($2::text[]) AND archived_at IS NULL`,
      [householdDbId, parsed],
    );
    const resolved = new Map(result.rows.map((row) => [row.account_id, row.id]));
    if (resolved.size !== new Set(parsed).size) throw referenceError(
      'posting_account_not_found', 'One or more active posting accounts were not found',
      { requestedAccountCount: new Set(parsed).size, resolvedAccountCount: resolved.size },
    );
    return resolved;
  }

  private async insertJournalTags(client: PoolClient, householdDbId: string,
    journalDbId: string, tagIds: readonly string[]): Promise<void> {
    for (const tagId of tagIds) {
      const result = await client.query(
        `INSERT INTO accounting.journal_tags (household_id, journal_id, tag_id)
         SELECT $1, $2, id FROM accounting.tags
         WHERE household_id = $1 AND tag_id = $3 AND archived_at IS NULL`,
        [householdDbId, journalDbId, TagIdSchema.parse(tagId)],
      );
      if (result.rowCount !== 1) throw referenceError(
        'journal_tag_not_found', 'Active journal tag was not found', { tagId },
      );
    }
  }

  private async insertPostingTags(client: PoolClient, householdDbId: string,
    postingDbId: string, tagIds: readonly string[]): Promise<void> {
    for (const tagId of tagIds) {
      const result = await client.query(
        `INSERT INTO accounting.posting_tags (household_id, posting_id, tag_id)
         SELECT $1, $2, id FROM accounting.tags
         WHERE household_id = $1 AND tag_id = $3 AND archived_at IS NULL`,
        [householdDbId, postingDbId, TagIdSchema.parse(tagId)],
      );
      if (result.rowCount !== 1) throw referenceError(
        'posting_tag_not_found', 'Active posting tag was not found', { tagId },
      );
    }
  }
}
