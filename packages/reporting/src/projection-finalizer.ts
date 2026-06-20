import type { PoolClient } from 'pg';

export class ProjectionFinalizer {
  async finalizeDay(client: Pick<PoolClient, 'query'>, input: {
    householdId: string;
    balanceDate: string;
  }): Promise<void> {
    await client.query(
      `INSERT INTO reporting.account_daily_balances
        (household_id, account_id, balance_date, native_amount, native_currency,
         reporting_amount, reporting_currency)
       SELECT current.household_id, current.account_id, $2::date,
         current.native_amount, current.native_currency,
         current.reporting_amount, current.reporting_currency
       FROM reporting.account_current_balances current
       JOIN operations.households household ON household.id = current.household_id
       WHERE household.household_id = $1 AND current.as_of <= $2::date
       ON CONFLICT (household_id, account_id, balance_date) DO UPDATE SET
         native_amount = EXCLUDED.native_amount,
         reporting_amount = EXCLUDED.reporting_amount,
         finalized_at = clock_timestamp()`,
      [input.householdId, input.balanceDate],
    );

    await client.query(
      `INSERT INTO reporting.household_net_worth_daily
        (household_id, balance_date, asset_reporting_amount, liability_reporting_amount,
         net_worth_reporting_amount, reporting_currency)
       SELECT household.id, $2::date,
         coalesce(sum(daily.reporting_amount) FILTER (WHERE account.accounting_class='asset'), 0),
         coalesce(sum(daily.reporting_amount) FILTER (WHERE account.accounting_class='liability'), 0),
         coalesce(sum(CASE
           WHEN account.accounting_class='asset' THEN daily.reporting_amount
           WHEN account.accounting_class='liability' THEN -daily.reporting_amount
           ELSE 0 END), 0),
         household.reporting_currency
       FROM operations.households household
       LEFT JOIN reporting.account_daily_balances daily
         ON daily.household_id = household.id AND daily.balance_date = $2::date
       LEFT JOIN accounting.accounts account
         ON account.household_id = daily.household_id AND account.id = daily.account_id
       WHERE household.household_id = $1
       GROUP BY household.id, household.reporting_currency
       ON CONFLICT (household_id, balance_date) DO UPDATE SET
         asset_reporting_amount = EXCLUDED.asset_reporting_amount,
         liability_reporting_amount = EXCLUDED.liability_reporting_amount,
         net_worth_reporting_amount = EXCLUDED.net_worth_reporting_amount,
         finalized_at = clock_timestamp()`,
      [input.householdId, input.balanceDate],
    );
  }
}
