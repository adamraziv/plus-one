import {
  AccountIdSchema, AccountSourceMappingIdSchema, BookConfigurationIdSchema,
  BookIdSchema, CounterpartyIdSchema,
  CurrencyCodeSchema, HouseholdIdSchema, LocalDateSchema, PeriodIdSchema, PlusOneError,
  TagIdSchema,
  type AccountingClassV1, type JsonValue,
} from '@plus-one/contracts';
import type { PoolClient } from 'pg';
import { normalizeAccountingError } from '../errors.js';

async function householdDbId(client: PoolClient, householdId: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    'SELECT id::text FROM operations.households WHERE household_id = $1', [HouseholdIdSchema.parse(householdId)],
  );
  if (result.rows[0] === undefined) throw new PlusOneError({
    category: 'validation_rejected', code: 'household_not_found',
    message: 'Household was not found', retry: 'never',
    receiptLookupRequired: false, details: { householdId },
  });
  return result.rows[0].id;
}

async function bookDbId(client: PoolClient, householdId: string, bookId: string): Promise<{
  householdDbId: string; bookDbId: string;
}> {
  const result = await client.query<{ household_db_id: string; book_db_id: string }>(
    `SELECT household.id::text AS household_db_id, book.id::text AS book_db_id
     FROM operations.households household
     JOIN accounting.books book ON book.household_id = household.id
     WHERE household.household_id = $1 AND book.book_id = $2`,
    [HouseholdIdSchema.parse(householdId), BookIdSchema.parse(bookId)],
  );
  if (result.rows[0] === undefined) throw new PlusOneError({
    category: 'validation_rejected', code: 'accounting_book_not_found',
    message: 'Accounting book was not found', retry: 'never',
    receiptLookupRequired: false, details: { householdId, bookId },
  });
  return { householdDbId: result.rows[0].household_db_id, bookDbId: result.rows[0].book_db_id };
}

export class AccountingRepository {
  async createBookWithConfiguration(client: PoolClient, input: {
    householdId: string; bookId: string; configurationId: string; name: string;
    reportingCurrency: string; effectiveFrom: string;
  }): Promise<void> {
    try {
      const household = await householdDbId(client, input.householdId);
      const book = await client.query<{ id: string }>(
        `INSERT INTO accounting.books (book_id, household_id, name)
         VALUES ($1, $2, $3) RETURNING id::text`,
        [BookIdSchema.parse(input.bookId), household, input.name],
      );
      await client.query(
        `INSERT INTO accounting.book_configurations
         (configuration_id, household_id, book_id, reporting_currency, effective_from)
         VALUES ($1, $2, $3, $4, $5)`,
        [BookConfigurationIdSchema.parse(input.configurationId), household, book.rows[0]!.id,
          CurrencyCodeSchema.parse(input.reportingCurrency), LocalDateSchema.parse(input.effectiveFrom)],
      );
    } catch (error) { throw normalizeAccountingError(error); }
  }

  async createAccount(client: PoolClient, input: {
    householdId: string; bookId: string; accountId: string; parentAccountId?: string;
    name: string; purpose?: string; accountingClass: AccountingClassV1;
    normalBalance: 'debit' | 'credit'; nativeCurrency: string; ownershipLabel?: string;
  }): Promise<void> {
    try {
      const ids = await bookDbId(client, input.householdId, input.bookId);
      const parent = input.parentAccountId === undefined ? undefined
        : await this.accountDbId(client, ids.householdDbId, input.parentAccountId);
      await client.query(
        `INSERT INTO accounting.accounts
         (account_id, household_id, book_id, parent_account_id, name, purpose,
          accounting_class, normal_balance, native_currency, ownership_label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [AccountIdSchema.parse(input.accountId), ids.householdDbId, ids.bookDbId, parent ?? null,
          input.name, input.purpose ?? null, input.accountingClass, input.normalBalance,
          CurrencyCodeSchema.parse(input.nativeCurrency), input.ownershipLabel ?? null],
      );
    } catch (error) { throw normalizeAccountingError(error); }
  }

  async updateAccount(client: PoolClient, input: {
    householdId: string; bookId: string; accountId: string; parentAccountId?: string;
    name: string; purpose?: string; accountingClass: AccountingClassV1;
    normalBalance: 'debit' | 'credit'; nativeCurrency: string; ownershipLabel?: string;
  }): Promise<void> {
    try {
      const ids = await bookDbId(client, input.householdId, input.bookId);
      const account = await this.accountDbId(client, ids.householdDbId, input.accountId);
      const parent = input.parentAccountId === undefined ? null
        : await this.accountDbId(client, ids.householdDbId, input.parentAccountId);
      const result = await client.query(
        `UPDATE accounting.accounts
         SET parent_account_id = $1, name = $2, purpose = $3, accounting_class = $4,
           normal_balance = $5, native_currency = $6, ownership_label = $7
         WHERE household_id = $8 AND book_id = $9 AND id = $10 AND archived_at IS NULL`,
        [parent, input.name, input.purpose ?? null, input.accountingClass,
          input.normalBalance, CurrencyCodeSchema.parse(input.nativeCurrency),
          input.ownershipLabel ?? null, ids.householdDbId, ids.bookDbId, account],
      );
      if (result.rowCount !== 1) throw new PlusOneError({
        category: 'validation_rejected', code: 'active_account_not_found',
        message: 'Active account was not found', retry: 'never',
        receiptLookupRequired: false, details: { accountId: input.accountId },
      });
    } catch (error) { throw normalizeAccountingError(error); }
  }

  async createAccountSourceMapping(client: PoolClient, input: {
    mappingId: string; householdId: string; bookId: string; accountId: string;
    sourceSystem: string; externalAccountId: string;
    metadata: Record<string, JsonValue>;
  }): Promise<void> {
    try {
      const ids = await bookDbId(client, input.householdId, input.bookId);
      const account = await this.accountDbId(client, ids.householdDbId, input.accountId);
      await client.query(
        `INSERT INTO accounting.account_source_mappings
         (mapping_id, household_id, book_id, account_id, source_system,
          external_account_id, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [AccountSourceMappingIdSchema.parse(input.mappingId), ids.householdDbId, ids.bookDbId,
          account, input.sourceSystem, input.externalAccountId, input.metadata],
      );
    } catch (error) { throw normalizeAccountingError(error); }
  }

  async archiveAccountSourceMapping(client: PoolClient, input: {
    householdId: string; mappingId: string;
  }): Promise<void> {
    try {
      const result = await client.query(
        `UPDATE accounting.account_source_mappings SET archived_at = clock_timestamp()
         WHERE household_id = (SELECT id FROM operations.households WHERE household_id = $1)
           AND mapping_id = $2 AND archived_at IS NULL`,
        [HouseholdIdSchema.parse(input.householdId),
          AccountSourceMappingIdSchema.parse(input.mappingId)],
      );
      if (result.rowCount !== 1) throw new PlusOneError({
        category: 'validation_rejected', code: 'active_account_source_mapping_not_found',
        message: 'Active account source mapping was not found', retry: 'never',
        receiptLookupRequired: false, details: { mappingId: input.mappingId },
      });
    } catch (error) { throw normalizeAccountingError(error); }
  }

  async archiveAccount(client: PoolClient, householdId: string, accountId: string): Promise<void> {
    try {
      const result = await client.query(
        `UPDATE accounting.accounts SET archived_at = clock_timestamp()
         WHERE household_id = (SELECT id FROM operations.households WHERE household_id = $1)
           AND account_id = $2 AND archived_at IS NULL`,
        [HouseholdIdSchema.parse(householdId), AccountIdSchema.parse(accountId)],
      );
      if (result.rowCount !== 1) throw new PlusOneError({
        category: 'validation_rejected', code: 'active_account_not_found',
        message: 'Active account was not found', retry: 'never',
        receiptLookupRequired: false, details: { accountId },
      });
    } catch (error) { throw normalizeAccountingError(error); }
  }

  async createPeriod(client: PoolClient, input: {
    householdId: string; bookId: string; periodId: string; periodStart: string; periodEnd: string;
  }): Promise<void> {
    try {
      const ids = await bookDbId(client, input.householdId, input.bookId);
      await client.query(
        `INSERT INTO accounting.periods
         (period_id, household_id, book_id, period_start, period_end)
         VALUES ($1,$2,$3,$4,$5)`,
        [PeriodIdSchema.parse(input.periodId), ids.householdDbId, ids.bookDbId,
          LocalDateSchema.parse(input.periodStart), LocalDateSchema.parse(input.periodEnd)],
      );
    } catch (error) { throw normalizeAccountingError(error); }
  }

  async addBookConfiguration(client: PoolClient, input: {
    householdId: string; bookId: string; configurationId: string;
    reportingCurrency: string; effectiveFrom: string;
  }): Promise<void> {
    try {
      const ids = await bookDbId(client, input.householdId, input.bookId);
      await client.query(
        `INSERT INTO accounting.book_configurations
         (configuration_id, household_id, book_id, reporting_currency, effective_from)
         VALUES ($1,$2,$3,$4,$5)`,
        [BookConfigurationIdSchema.parse(input.configurationId), ids.householdDbId, ids.bookDbId,
          CurrencyCodeSchema.parse(input.reportingCurrency), LocalDateSchema.parse(input.effectiveFrom)],
      );
    } catch (error) { throw normalizeAccountingError(error); }
  }

  async createCounterparty(client: PoolClient, input: {
    householdId: string; counterpartyId: string; displayName: string;
  }): Promise<void> {
    try {
      await client.query(
        `INSERT INTO accounting.counterparties (counterparty_id, household_id, display_name)
         VALUES ($1, (SELECT id FROM operations.households WHERE household_id = $2), $3)`,
        [CounterpartyIdSchema.parse(input.counterpartyId),
          HouseholdIdSchema.parse(input.householdId), input.displayName],
      );
    } catch (error) { throw normalizeAccountingError(error); }
  }

  async createTag(client: PoolClient, input: {
    householdId: string; tagId: string; name: string;
  }): Promise<void> {
    try {
      await client.query(
        `INSERT INTO accounting.tags (tag_id, household_id, name)
         VALUES ($1, (SELECT id FROM operations.households WHERE household_id = $2), $3)`,
        [TagIdSchema.parse(input.tagId), HouseholdIdSchema.parse(input.householdId), input.name],
      );
    } catch (error) { throw normalizeAccountingError(error); }
  }

  async archiveCounterparty(client: PoolClient, householdId: string,
    counterpartyId: string): Promise<void> {
    try {
      const result = await client.query(
        `UPDATE accounting.counterparties SET archived_at = clock_timestamp(),
         updated_at = clock_timestamp()
         WHERE household_id = (SELECT id FROM operations.households WHERE household_id = $1)
           AND counterparty_id = $2 AND archived_at IS NULL`,
        [HouseholdIdSchema.parse(householdId), CounterpartyIdSchema.parse(counterpartyId)],
      );
      if (result.rowCount !== 1) throw new PlusOneError({
        category: 'validation_rejected', code: 'active_counterparty_not_found',
        message: 'Active counterparty was not found', retry: 'never',
        receiptLookupRequired: false, details: { counterpartyId },
      });
    } catch (error) { throw normalizeAccountingError(error); }
  }

  async archiveTag(client: PoolClient, householdId: string, tagId: string): Promise<void> {
    try {
      const result = await client.query(
        `UPDATE accounting.tags SET archived_at = clock_timestamp(),
         updated_at = clock_timestamp()
         WHERE household_id = (SELECT id FROM operations.households WHERE household_id = $1)
           AND tag_id = $2 AND archived_at IS NULL`,
        [HouseholdIdSchema.parse(householdId), TagIdSchema.parse(tagId)],
      );
      if (result.rowCount !== 1) throw new PlusOneError({
        category: 'validation_rejected', code: 'active_tag_not_found',
        message: 'Active tag was not found', retry: 'never',
        receiptLookupRequired: false, details: { tagId },
      });
    } catch (error) { throw normalizeAccountingError(error); }
  }

  async transitionPeriod(client: PoolClient, input: {
    householdId: string; periodId: string; expected: 'open' | 'closed'; to: 'open' | 'closed';
  }): Promise<void> {
    try {
      const result = await client.query(
        `UPDATE accounting.periods SET state = $1,
         closed_at = CASE WHEN $1 = 'closed' THEN clock_timestamp() ELSE NULL END,
         reopened_at = CASE WHEN $1 = 'open' THEN clock_timestamp() ELSE reopened_at END,
         updated_at = clock_timestamp()
         WHERE household_id = (SELECT id FROM operations.households WHERE household_id = $2)
           AND period_id = $3 AND state = $4`,
        [input.to, HouseholdIdSchema.parse(input.householdId), PeriodIdSchema.parse(input.periodId), input.expected],
      );
      if (result.rowCount !== 1) throw new PlusOneError({
        category: 'serialization_conflict', code: 'period_state_conflict',
        message: 'Accounting period state changed concurrently or was not found',
        retry: 'after_state_resolution', receiptLookupRequired: false,
        details: { periodId: input.periodId, expected: input.expected },
      });
    } catch (error) { throw normalizeAccountingError(error); }
  }

  private async accountDbId(client: PoolClient, householdDbId: string, accountId: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      'SELECT id::text FROM accounting.accounts WHERE household_id = $1 AND account_id = $2',
      [householdDbId, AccountIdSchema.parse(accountId)],
    );
    if (result.rows[0] === undefined) throw new PlusOneError({
      category: 'validation_rejected', code: 'account_not_found',
      message: 'Account was not found', retry: 'never',
      receiptLookupRequired: false, details: { accountId },
    });
    return result.rows[0].id;
  }
}

export { bookDbId };
