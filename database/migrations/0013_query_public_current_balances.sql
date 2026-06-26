SET ROLE plus_one_owner;
BEGIN;
SET LOCAL search_path = pg_catalog, reporting, operations;

CREATE VIEW reporting.current_balances AS
SELECT household.household_id, account.account_id, balance.as_of,
  balance.native_amount, balance.native_currency,
  balance.reporting_amount, balance.reporting_currency,
  balance.freshness_at
FROM reporting.account_current_balances balance
JOIN operations.households household ON household.id = balance.household_id
JOIN accounting.accounts account
  ON account.household_id = balance.household_id AND account.id = balance.account_id;

UPDATE reporting.relation_metadata
SET relation_name = 'reporting.current_balances'
WHERE relation_name = 'reporting.account_current_balances';

GRANT SELECT ON reporting.current_balances TO plus_one_query;
REVOKE SELECT ON reporting.account_current_balances FROM plus_one_query;

COMMIT;
RESET ROLE;
