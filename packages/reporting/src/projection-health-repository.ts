import type { PoolClient } from 'pg';

export class ProjectionHealthRepository {
  async checkCurrentBalanceDrift(client: Pick<PoolClient, 'query'>, input: {
    householdId: string;
    asOf: string;
  }): Promise<Array<{ accountId: string; projected: string; authoritative: string }>> {
    const result = await client.query<{
      account_id: string;
      account_db_id: string;
      household_db_id: string;
      projected: string;
      authoritative: string;
      currency: string;
    }>(
      `WITH authoritative AS (
         SELECT household.id AS household_db_id, account.id AS account_db_id, account.account_id,
           coalesce(sum(CASE WHEN posting.direction = account.normal_balance
             THEN posting.account_native_amount ELSE -posting.account_native_amount END)
             FILTER (WHERE journal.id IS NOT NULL), 0) AS amount,
           account.native_currency AS currency
         FROM operations.households household
         JOIN accounting.accounts account ON account.household_id = household.id
         LEFT JOIN accounting.postings posting
           ON posting.household_id = account.household_id AND posting.account_id = account.id
         LEFT JOIN accounting.journals journal
           ON journal.household_id = posting.household_id AND journal.id = posting.journal_id
          AND journal.effective_on <= $2::date
         WHERE household.household_id = $1
         GROUP BY household.id, account.id, account.account_id, account.native_currency
       )
       SELECT auth.household_db_id::text, auth.account_db_id::text, auth.account_id,
         current.native_amount::text AS projected, auth.amount::text AS authoritative, auth.currency
       FROM authoritative auth
       JOIN reporting.account_current_balances current
         ON current.household_id = auth.household_db_id AND current.account_id = auth.account_db_id
       WHERE current.native_amount <> auth.amount`,
      [input.householdId, input.asOf],
    );
    for (const row of result.rows) {
      await client.query(
        `INSERT INTO reporting.projection_drift_records
          (household_id, projection_key, account_id, projection_date,
           projected_amount, authoritative_amount, currency)
         VALUES ($1, 'current_balances', $2, $3::date, $4, $5, $6)`,
        [row.household_db_id, row.account_db_id, input.asOf, row.projected, row.authoritative, row.currency],
      );
    }
    await client.query(
      `INSERT INTO reporting.projection_health(household_id, projection_key, projection_date, status, detail)
       SELECT id, 'current_balances', $2::date, $3,
         jsonb_build_object('driftCount', $4::int)
       FROM operations.households WHERE household_id=$1
       ON CONFLICT (household_id, projection_key, projection_date) DO UPDATE SET
         status=EXCLUDED.status, detail=EXCLUDED.detail, checked_at=clock_timestamp()`,
      [input.householdId, input.asOf, result.rows.length === 0 ? 'healthy' : 'unhealthy', result.rows.length],
    );
    return result.rows.map((row) => ({
      accountId: row.account_id,
      projected: row.projected,
      authoritative: row.authoritative,
    }));
  }

  async checkDailyBalanceDrift(client: Pick<PoolClient, 'query'>, input: {
    householdId: string;
    balanceDate: string;
  }): Promise<Array<{ accountId: string; projected: string; authoritative: string }>> {
    const result = await client.query<{
      account_id: string;
      account_db_id: string;
      household_db_id: string;
      projected: string;
      authoritative: string;
      currency: string;
    }>(
      `WITH authoritative AS (
         SELECT household.id AS household_db_id, account.id AS account_db_id, account.account_id,
           current.native_amount AS amount, current.native_currency AS currency
         FROM operations.households household
         JOIN reporting.account_current_balances current ON current.household_id = household.id
         JOIN accounting.accounts account
           ON account.household_id = current.household_id AND account.id = current.account_id
         WHERE household.household_id = $1 AND current.as_of <= $2::date
       )
       SELECT auth.household_db_id::text, auth.account_db_id::text, auth.account_id,
         daily.native_amount::text AS projected, auth.amount::text AS authoritative, auth.currency
       FROM authoritative auth
       JOIN reporting.account_daily_balances daily
         ON daily.household_id = auth.household_db_id
        AND daily.account_id = auth.account_db_id
        AND daily.balance_date = $2::date
       WHERE daily.native_amount <> auth.amount`,
      [input.householdId, input.balanceDate],
    );
    for (const row of result.rows) {
      await client.query(
        `INSERT INTO reporting.projection_drift_records
          (household_id, projection_key, account_id, projection_date,
           projected_amount, authoritative_amount, currency)
         VALUES ($1, 'daily_balances', $2, $3::date, $4, $5, $6)`,
        [row.household_db_id, row.account_db_id, input.balanceDate, row.projected, row.authoritative, row.currency],
      );
    }
    await this.recordHealth(client, input.householdId, 'daily_balances', input.balanceDate, result.rows.length);
    return result.rows.map((row) => ({
      accountId: row.account_id,
      projected: row.projected,
      authoritative: row.authoritative,
    }));
  }

  async checkNetWorthDrift(client: Pick<PoolClient, 'query'>, input: {
    householdId: string;
    balanceDate: string;
  }): Promise<Array<{ accountId: string; projected: string; authoritative: string }>> {
    const result = await client.query<{
      household_db_id: string;
      projected: string;
      authoritative: string;
      currency: string;
    }>(
      `WITH authoritative AS (
         SELECT household.id AS household_db_id,
           coalesce(sum(CASE
             WHEN account.accounting_class='asset' THEN daily.reporting_amount
             WHEN account.accounting_class='liability' THEN -daily.reporting_amount
             ELSE 0 END), 0) AS amount,
           household.reporting_currency AS currency
         FROM operations.households household
         LEFT JOIN reporting.account_daily_balances daily
           ON daily.household_id = household.id AND daily.balance_date = $2::date
         LEFT JOIN accounting.accounts account
           ON account.household_id = daily.household_id AND account.id = daily.account_id
         WHERE household.household_id = $1
         GROUP BY household.id, household.reporting_currency
       )
       SELECT auth.household_db_id::text, net.net_worth_reporting_amount::text AS projected,
         auth.amount::text AS authoritative, auth.currency
       FROM authoritative auth
       JOIN reporting.household_net_worth_daily net
         ON net.household_id = auth.household_db_id AND net.balance_date = $2::date
       WHERE net.net_worth_reporting_amount <> auth.amount`,
      [input.householdId, input.balanceDate],
    );
    for (const row of result.rows) {
      await client.query(
        `INSERT INTO reporting.projection_drift_records
          (household_id, projection_key, projection_date,
           projected_amount, authoritative_amount, currency)
         VALUES ($1, 'net_worth', $2::date, $3, $4, $5)`,
        [row.household_db_id, input.balanceDate, row.projected, row.authoritative, row.currency],
      );
    }
    await this.recordHealth(client, input.householdId, 'net_worth', input.balanceDate, result.rows.length);
    return result.rows.map((row) => ({
      accountId: 'household',
      projected: row.projected,
      authoritative: row.authoritative,
    }));
  }

  private async recordHealth(client: Pick<PoolClient, 'query'>, householdId: string,
    projectionKey: 'daily_balances' | 'net_worth', date: string, driftCount: number): Promise<void> {
    await client.query(
      `INSERT INTO reporting.projection_health(household_id, projection_key, projection_date, status, detail)
       SELECT id, $2, $3::date, $4, jsonb_build_object('driftCount', $5::int)
       FROM operations.households WHERE household_id=$1
       ON CONFLICT (household_id, projection_key, projection_date) DO UPDATE SET
         status=EXCLUDED.status, detail=EXCLUDED.detail, checked_at=clock_timestamp()`,
      [householdId, projectionKey, date, driftCount === 0 ? 'healthy' : 'unhealthy', driftCount],
    );
  }
}
