import type { PoolClient } from 'pg';

export class ProjectionWriter {
  async applyJournal(client: PoolClient, input: {
    householdId: string;
    journalId: string;
    postingIds: readonly string[];
    effectiveOn: string;
  }): Promise<void> {
    await client.query(
      `INSERT INTO reporting.account_current_balances
        (household_id, account_id, as_of, native_amount, native_currency,
         reporting_amount, reporting_currency, last_journal_id)
       SELECT posting.household_id, posting.account_id, $3::date,
         sum(CASE WHEN posting.direction = account.normal_balance
           THEN posting.account_native_amount ELSE -posting.account_native_amount END),
         account.native_currency,
         sum(CASE WHEN posting.direction = account.normal_balance
           THEN posting.account_native_amount ELSE -posting.account_native_amount END),
         household.reporting_currency,
         journal.id
       FROM accounting.postings posting
       JOIN accounting.journals journal
         ON journal.household_id = posting.household_id AND journal.id = posting.journal_id
       JOIN accounting.accounts account
         ON account.household_id = posting.household_id AND account.id = posting.account_id
       JOIN operations.households household ON household.id = posting.household_id
       WHERE household.household_id = $1
         AND journal.journal_id = $2
         AND posting.posting_id = ANY($4::text[])
       GROUP BY posting.household_id, posting.account_id, account.native_currency,
         household.reporting_currency, journal.id
       ON CONFLICT (household_id, account_id) DO UPDATE SET
         as_of = greatest(reporting.account_current_balances.as_of, EXCLUDED.as_of),
         native_amount = reporting.account_current_balances.native_amount + EXCLUDED.native_amount,
         reporting_amount = reporting.account_current_balances.reporting_amount + EXCLUDED.reporting_amount,
         last_journal_id = EXCLUDED.last_journal_id,
         freshness_at = clock_timestamp(),
         updated_at = clock_timestamp()`,
      [input.householdId, input.journalId, input.effectiveOn, [...input.postingIds]],
    );
  }
}
