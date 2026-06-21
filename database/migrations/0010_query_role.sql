DO $role_settings$
DECLARE
  can_manage_roles boolean;
BEGIN
  SELECT rolcreaterole OR rolsuper INTO can_manage_roles FROM pg_roles WHERE rolname = current_user;
  IF can_manage_roles THEN
    ALTER ROLE plus_one_query SET search_path = reporting, pg_catalog;
    ALTER ROLE plus_one_query SET statement_timeout = '5s';
    ALTER ROLE plus_one_query SET idle_in_transaction_session_timeout = '10s';
    ALTER ROLE plus_one_query SET default_transaction_read_only = on;
  END IF;
END
$role_settings$;

SET ROLE plus_one_owner;
BEGIN;
SET LOCAL search_path = pg_catalog, reporting, operations;

GRANT USAGE ON SCHEMA reporting TO plus_one_query;

GRANT SELECT ON
  reporting.accounts,
  reporting.account_current_balances,
  reporting.account_daily_balances,
  reporting.household_net_worth_daily,
  reporting.journal_activity,
  reporting.categorized_transactions,
  reporting.cash_flow_monthly,
  reporting.obligation_occurrences,
  reporting.budget_variance,
  reporting.savings_goal_progress,
  reporting.debt_progress,
  reporting.reconciliation_status,
  reporting.source_freshness,
  reporting.relation_metadata
TO plus_one_query;

REVOKE ALL ON ALL SEQUENCES IN SCHEMA reporting FROM plus_one_query;
REVOKE CREATE ON SCHEMA reporting FROM plus_one_query;

COMMIT;
RESET ROLE;
