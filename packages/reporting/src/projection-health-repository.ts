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
}
