import type { PoolClient } from 'pg';
import { ProjectionFinalizer } from './projection-finalizer.js';

export class ProjectionRebuilder {
  async rebuildCurrentBalances(client: Pick<PoolClient, 'query'>, input: {
    householdId: string;
    asOf: string;
  }): Promise<void> {
    await client.query(
      `DELETE FROM reporting.account_current_balances
       WHERE household_id = (SELECT id FROM operations.households WHERE household_id=$1)`,
      [input.householdId],
    );
    await client.query(
      `INSERT INTO reporting.account_current_balances
        (household_id, account_id, as_of, native_amount, native_currency,
         reporting_amount, reporting_currency, last_journal_id)
       SELECT household.id, account.id, $2::date,
         coalesce(sum(CASE
           WHEN account.native_currency <> household.reporting_currency THEN 0
           WHEN posting.direction = account.normal_balance THEN posting.account_native_amount
           ELSE -posting.account_native_amount END)
           FILTER (WHERE journal.id IS NOT NULL), 0),
         account.native_currency,
         coalesce(sum(CASE WHEN posting.direction = account.normal_balance
           THEN posting.account_native_amount ELSE -posting.account_native_amount END)
           FILTER (WHERE journal.id IS NOT NULL), 0),
         household.reporting_currency,
         max(journal.id)
       FROM operations.households household
       JOIN accounting.accounts account ON account.household_id = household.id
       LEFT JOIN accounting.postings posting
         ON posting.household_id = account.household_id AND posting.account_id = account.id
       LEFT JOIN accounting.journals journal
         ON journal.household_id = posting.household_id AND journal.id = posting.journal_id
        AND journal.effective_on <= $2::date
       WHERE household.household_id = $1
       GROUP BY household.id, account.id, account.native_currency, household.reporting_currency
       HAVING max(journal.id) IS NOT NULL`,
      [input.householdId, input.asOf],
    );
    await client.query(
      `UPDATE reporting.projection_drift_records SET resolved_at = clock_timestamp()
       WHERE household_id = (SELECT id FROM operations.households WHERE household_id=$1)
         AND projection_key='current_balances' AND resolved_at IS NULL`,
      [input.householdId],
    );
  }

  async rebuildDailyBalances(client: Pick<PoolClient, 'query'>, input: {
    householdId: string;
    balanceDate: string;
  }): Promise<void> {
    await new ProjectionFinalizer().finalizeDay(client, input);
    await client.query(
      `UPDATE reporting.projection_drift_records SET resolved_at = clock_timestamp()
       WHERE household_id = (SELECT id FROM operations.households WHERE household_id=$1)
         AND projection_key='daily_balances' AND projection_date=$2::date
         AND resolved_at IS NULL`,
      [input.householdId, input.balanceDate],
    );
  }

  async rebuildNetWorth(client: Pick<PoolClient, 'query'>, input: {
    householdId: string;
    balanceDate: string;
  }): Promise<void> {
    await new ProjectionFinalizer().finalizeDay(client, input);
    await client.query(
      `UPDATE reporting.projection_drift_records SET resolved_at = clock_timestamp()
       WHERE household_id = (SELECT id FROM operations.households WHERE household_id=$1)
         AND projection_key='net_worth' AND projection_date=$2::date
         AND resolved_at IS NULL`,
      [input.householdId, input.balanceDate],
    );
  }
}
