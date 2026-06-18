import {
  AccountIdSchema, CounterpartyIdSchema, JournalDraftInputSchemaV1, PlusOneError,
  TagIdSchema, type JournalDraftInputV1,
} from '@plus-one/contracts';
import type { PoolClient } from 'pg';
import { normalizeAccountingError } from '../errors.js';
import { bookDbId } from './accounting-repository.js';

export class JournalDraftRepository {
  async insertVersion(client: PoolClient, candidate: JournalDraftInputV1): Promise<void> {
    const input = JournalDraftInputSchemaV1.parse(candidate);
    try {
      const ids = await bookDbId(client, input.householdId, input.bookId);
      const previous = input.previousDraftId === undefined ? null
        : await this.resolveDraft(client, ids.householdDbId, input.previousDraftId);
      const counterparty = input.counterpartyId === undefined ? null
        : await this.resolveCounterparty(client, ids.householdDbId, input.counterpartyId);
      const tagIds = await this.validateTags(client, ids.householdDbId, input.tagIds);
      const draft = await client.query<{ id: string }>(
        `INSERT INTO accounting.journal_drafts
         (draft_id, draft_series_id, version, previous_draft_id, household_id, book_id,
          task_id, checked_artifact_id, checked_artifact_hash, journal_type,
          transaction_currency, occurred_on, effective_on, settlement_on, source_on,
          description, counterparty_id, tag_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING id::text`,
        [input.draftId, input.draftSeriesId, input.version, previous,
          ids.householdDbId, ids.bookDbId, input.taskId, input.checkedArtifactId,
          input.checkedArtifactHash, input.journalType, input.transactionCurrency,
          input.occurredOn, input.effectiveOn, input.settlementOn ?? null,
          input.sourceOn ?? null, input.description, counterparty, tagIds],
      );
      for (const [index, posting] of input.postings.entries()) {
        const account = await client.query<{ id: string }>(
          `SELECT id::text FROM accounting.accounts
           WHERE household_id = $1 AND account_id = $2`,
          [ids.householdDbId, AccountIdSchema.parse(posting.accountId)],
        );
        if (account.rows[0] === undefined) throw new PlusOneError({
          category: 'validation_rejected', code: 'draft_account_not_found',
          message: 'Draft posting account was not found', retry: 'never',
          receiptLookupRequired: false, details: { accountId: posting.accountId },
        });
        await client.query(
          `INSERT INTO accounting.draft_postings
           (household_id, draft_id, ordinal, account_id, direction, transaction_amount,
            account_native_amount, account_native_currency, exchange_rate,
            exchange_rate_quote, exchange_rate_date, exchange_rate_source, memo, tag_ids)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [ids.householdDbId, draft.rows[0]!.id, index + 1, account.rows[0].id,
            posting.direction, posting.transactionAmount, posting.accountNativeAmount,
            posting.accountNativeCurrency, posting.exchangeRate ?? null,
            posting.exchangeRateQuote ?? null, posting.exchangeRateDate ?? null,
            posting.exchangeRateSource ?? null, posting.memo ?? null,
            await this.validateTags(client, ids.householdDbId, posting.tagIds)],
        );
      }
    } catch (error) { throw normalizeAccountingError(error); }
  }

  private async resolveDraft(client: PoolClient, householdDbId: string, draftId: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      'SELECT id::text FROM accounting.journal_drafts WHERE household_id = $1 AND draft_id = $2',
      [householdDbId, draftId],
    );
    if (result.rows[0] === undefined) throw new PlusOneError({
      category: 'validation_rejected', code: 'previous_draft_not_found',
      message: 'Previous draft version was not found', retry: 'never',
      receiptLookupRequired: false, details: { draftId },
    });
    return result.rows[0].id;
  }

  private async resolveCounterparty(client: PoolClient, householdDbId: string,
    counterpartyId: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      `SELECT id::text FROM accounting.counterparties
       WHERE household_id = $1 AND counterparty_id = $2 AND archived_at IS NULL`,
      [householdDbId, CounterpartyIdSchema.parse(counterpartyId)],
    );
    if (result.rows[0] === undefined) throw new PlusOneError({
      category: 'validation_rejected', code: 'counterparty_not_found',
      message: 'Active counterparty was not found', retry: 'never',
      receiptLookupRequired: false, details: { counterpartyId },
    });
    return result.rows[0].id;
  }

  private async validateTags(client: PoolClient, householdDbId: string,
    tagIds: readonly string[]): Promise<string[]> {
    const parsed = [...new Set(tagIds.map((tagId) => TagIdSchema.parse(tagId)))].sort();
    if (parsed.length === 0) return [];
    const result = await client.query<{ tag_id: string }>(
      `SELECT tag_id FROM accounting.tags
       WHERE household_id = $1 AND tag_id = ANY($2::text[]) AND archived_at IS NULL`,
      [householdDbId, parsed],
    );
    if (result.rowCount !== parsed.length) throw new PlusOneError({
      category: 'validation_rejected', code: 'draft_tag_not_found',
      message: 'One or more active draft tags were not found', retry: 'never',
      receiptLookupRequired: false, details: { requestedTagCount: parsed.length },
    });
    return parsed;
  }
}
