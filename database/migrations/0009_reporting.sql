SET ROLE plus_one_owner;
BEGIN;
SET LOCAL search_path = pg_catalog, reporting, operations;

CREATE TABLE reporting.account_current_balances (
  household_id bigint NOT NULL,
  account_id bigint NOT NULL,
  as_of date NOT NULL,
  native_amount operations.decimal_amount NOT NULL,
  native_currency operations.currency_code NOT NULL REFERENCES operations.currency_metadata(currency_code),
  reporting_amount operations.decimal_amount NOT NULL,
  reporting_currency operations.currency_code NOT NULL REFERENCES operations.currency_metadata(currency_code),
  last_journal_id bigint NOT NULL,
  freshness_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (household_id, account_id),
  FOREIGN KEY (household_id) REFERENCES operations.households(id),
  FOREIGN KEY (household_id, account_id) REFERENCES accounting.accounts(household_id, id),
  FOREIGN KEY (household_id, last_journal_id) REFERENCES accounting.journals(household_id, id)
);

CREATE TABLE reporting.account_daily_balances (
  household_id bigint NOT NULL,
  account_id bigint NOT NULL,
  balance_date date NOT NULL,
  native_amount operations.decimal_amount NOT NULL,
  native_currency operations.currency_code NOT NULL REFERENCES operations.currency_metadata(currency_code),
  reporting_amount operations.decimal_amount NOT NULL,
  reporting_currency operations.currency_code NOT NULL REFERENCES operations.currency_metadata(currency_code),
  finalized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (household_id, account_id, balance_date),
  FOREIGN KEY (household_id) REFERENCES operations.households(id),
  FOREIGN KEY (household_id, account_id) REFERENCES accounting.accounts(household_id, id)
);

CREATE TABLE reporting.household_net_worth_daily (
  household_id bigint NOT NULL REFERENCES operations.households(id),
  balance_date date NOT NULL,
  asset_reporting_amount operations.decimal_amount NOT NULL,
  liability_reporting_amount operations.decimal_amount NOT NULL,
  net_worth_reporting_amount operations.decimal_amount NOT NULL,
  reporting_currency operations.currency_code NOT NULL REFERENCES operations.currency_metadata(currency_code),
  finalized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (household_id, balance_date)
);

CREATE TABLE reporting.projection_health (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id bigint NOT NULL REFERENCES operations.households(id),
  projection_key text NOT NULL CHECK (projection_key IN ('current_balances','daily_balances','net_worth')),
  projection_date date,
  status text NOT NULL CHECK (status IN ('healthy','unhealthy','rebuilding')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (household_id, projection_key, projection_date)
);

CREATE TABLE reporting.projection_drift_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id bigint NOT NULL REFERENCES operations.households(id),
  projection_key text NOT NULL CHECK (projection_key IN ('current_balances','daily_balances','net_worth')),
  account_id bigint,
  projection_date date,
  projected_amount operations.decimal_amount NOT NULL,
  authoritative_amount operations.decimal_amount NOT NULL,
  currency operations.currency_code NOT NULL REFERENCES operations.currency_metadata(currency_code),
  detected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  FOREIGN KEY (household_id, account_id) REFERENCES accounting.accounts(household_id, id)
);

CREATE TABLE reporting.relation_metadata (
  relation_name text PRIMARY KEY CHECK (relation_name ~ '^reporting\.[a-z_]+$'),
  grain text[] NOT NULL CHECK (array_length(grain, 1) > 0),
  metrics text[] NOT NULL CHECK (array_length(metrics, 1) > 0),
  household_scoped boolean NOT NULL DEFAULT true CHECK (household_scoped),
  currency_behavior text NOT NULL CHECK (btrim(currency_behavior) <> ''),
  freshness text NOT NULL CHECK (btrim(freshness) <> ''),
  source_semantics text NOT NULL CHECK (btrim(source_semantics) <> '')
);

CREATE VIEW reporting.accounts AS
SELECT household.household_id, book.book_id, account.account_id, account.name,
  account.accounting_class, account.normal_balance, account.native_currency,
  account.ownership_label, account.archived_at
FROM accounting.accounts account
JOIN operations.households household ON household.id = account.household_id
JOIN accounting.books book ON book.id = account.book_id;

CREATE VIEW reporting.journal_activity AS
SELECT household.household_id, journal.journal_id, journal.journal_type,
  journal.effective_on, journal.occurred_on, journal.transaction_currency,
  journal.description, journal.posted_at, journal.reverses_journal_id, journal.replaces_journal_id
FROM accounting.journals journal
JOIN operations.households household ON household.id = journal.household_id;

CREATE VIEW reporting.categorized_transactions AS
SELECT household.household_id, journal.journal_id, posting.posting_id,
  journal.effective_on, account.account_id, account.name AS account_name,
  account.accounting_class, posting.direction, posting.account_native_amount,
  posting.account_native_currency, journal.description
FROM accounting.postings posting
JOIN accounting.journals journal
  ON journal.household_id = posting.household_id AND journal.id = posting.journal_id
JOIN accounting.accounts account
  ON account.household_id = posting.household_id AND account.id = posting.account_id
JOIN operations.households household ON household.id = posting.household_id;

CREATE VIEW reporting.cash_flow_monthly AS
SELECT household.household_id, date_trunc('month', journal.effective_on)::date AS month_start,
  account.accounting_class,
  sum(CASE WHEN posting.direction = account.normal_balance
    THEN posting.account_native_amount ELSE -posting.account_native_amount END)::text AS native_amount,
  account.native_currency
FROM accounting.postings posting
JOIN accounting.journals journal
  ON journal.household_id = posting.household_id AND journal.id = posting.journal_id
JOIN accounting.accounts account
  ON account.household_id = posting.household_id AND account.id = posting.account_id
JOIN operations.households household ON household.id = posting.household_id
WHERE account.accounting_class IN ('income','expense')
GROUP BY household.household_id, date_trunc('month', journal.effective_on)::date,
  account.accounting_class, account.native_currency;

CREATE VIEW reporting.obligation_occurrences AS
SELECT household.household_id, obligation.obligation_key, obligation.variant,
  obligation.name, occurrence.occurrence_date, occurrence.due_date,
  occurrence.expected_amount, occurrence.expected_currency, occurrence.status
FROM planning.obligation_occurrences occurrence
JOIN planning.recurring_obligations obligation
  ON obligation.household_id = occurrence.household_id AND obligation.id = occurrence.obligation_id
JOIN operations.households household ON household.id = occurrence.household_id
WHERE occurrence.archived_at IS NULL AND obligation.archived_at IS NULL;

CREATE VIEW reporting.budget_variance AS
SELECT household.household_id, scope.scope_key, category.category_key,
  allocation.period_start, allocation.period_end, allocation.amount AS planned_amount,
  allocation.currency AS planned_currency,
  coalesce(sum(CASE WHEN posting.direction = account.normal_balance
    THEN posting.account_native_amount ELSE -posting.account_native_amount END), 0)::text AS actual_amount
FROM planning.budget_allocations allocation
JOIN planning.budget_versions version
  ON version.household_id = allocation.household_id AND version.id = allocation.budget_version_id
JOIN planning.budget_scopes scope
  ON scope.household_id = version.household_id AND scope.id = version.scope_id
JOIN planning.budget_categories category
  ON category.household_id = allocation.household_id AND category.id = allocation.category_id
JOIN operations.households household ON household.id = allocation.household_id
LEFT JOIN planning.budget_category_account_mappings mapping
  ON mapping.household_id = allocation.household_id AND mapping.category_id = allocation.category_id
 AND mapping.archived_at IS NULL
LEFT JOIN accounting.accounts account
  ON account.household_id = mapping.household_id AND account.id = mapping.account_id
LEFT JOIN accounting.postings posting
  ON posting.household_id = mapping.household_id AND posting.account_id = mapping.account_id
LEFT JOIN accounting.journals journal
  ON journal.household_id = posting.household_id AND journal.id = posting.journal_id
 AND journal.effective_on BETWEEN allocation.period_start AND allocation.period_end
GROUP BY household.household_id, scope.scope_key, category.category_key,
  allocation.period_start, allocation.period_end, allocation.amount, allocation.currency;

CREATE VIEW reporting.savings_goal_progress AS
SELECT household.household_id, goal.goal_key, goal.name, goal.target_amount,
  goal.target_currency, goal.target_date,
  coalesce(sum(balance.native_amount) FILTER (WHERE balance.account_id = link.account_id), 0)::text AS current_amount
FROM planning.savings_goals goal
JOIN operations.households household ON household.id = goal.household_id
LEFT JOIN planning.savings_goal_accounts link
  ON link.household_id = goal.household_id AND link.goal_id = goal.id AND link.archived_at IS NULL
LEFT JOIN reporting.account_current_balances balance
  ON balance.household_id = link.household_id AND balance.account_id = link.account_id
WHERE goal.archived_at IS NULL
GROUP BY household.household_id, goal.goal_key, goal.name, goal.target_amount,
  goal.target_currency, goal.target_date;

CREATE VIEW reporting.debt_progress AS
SELECT household.household_id, debt.debt_plan_key, debt.name, account.account_id,
  loan.lender_name, debt.monthly_payment_amount, debt.monthly_payment_currency,
  balance.native_amount AS current_liability_amount, balance.native_currency
FROM planning.debt_plans debt
JOIN planning.loan_agreements loan
  ON loan.household_id = debt.household_id AND loan.id = debt.loan_agreement_id
JOIN accounting.accounts account
  ON account.household_id = debt.household_id AND account.id = debt.liability_account_id
JOIN operations.households household ON household.id = debt.household_id
LEFT JOIN reporting.account_current_balances balance
  ON balance.household_id = debt.household_id AND balance.account_id = debt.liability_account_id
WHERE debt.archived_at IS NULL;

CREATE VIEW reporting.reconciliation_status AS
SELECT household.household_id, snapshot.statement_snapshot_id, account.account_id,
  snapshot.period_start, snapshot.period_end, snapshot.opening_balance,
  snapshot.closing_balance, snapshot.currency, snapshot.created_at AS freshness_at
FROM ingestion.statement_snapshots snapshot
JOIN operations.households household ON household.id = snapshot.household_id
JOIN accounting.accounts account
  ON account.household_id = snapshot.household_id AND account.id = snapshot.account_id;

CREATE VIEW reporting.source_freshness AS
SELECT household.household_id, document.source_system,
  max(document.created_at) AS latest_source_at,
  count(*)::integer AS source_document_count
FROM ingestion.source_documents document
JOIN operations.households household ON household.id = document.household_id
GROUP BY household.household_id, document.source_system;

INSERT INTO reporting.relation_metadata
  (relation_name, grain, metrics, currency_behavior, freshness, source_semantics)
VALUES
  ('reporting.accounts', ARRAY['household','account'], ARRAY['account attributes'], 'Native currency only.', 'ledger freshness', 'Derived from accounting.accounts.'),
  ('reporting.account_current_balances', ARRAY['household','account'], ARRAY['current balance'], 'Native and household reporting currency.', 'projection freshness_at', 'Projection from posted journals.'),
  ('reporting.account_daily_balances', ARRAY['household','account','date'], ARRAY['daily closed balance'], 'Native and household reporting currency.', 'finalized_at', 'Projection from posted journals.'),
  ('reporting.household_net_worth_daily', ARRAY['household','date'], ARRAY['assets','liabilities','net worth'], 'Household reporting currency.', 'finalized_at', 'Projection from daily balances.'),
  ('reporting.journal_activity', ARRAY['household','journal'], ARRAY['journal facts'], 'Transaction currency.', 'ledger freshness', 'Derived from posted journals.'),
  ('reporting.categorized_transactions', ARRAY['household','posting'], ARRAY['categorized amounts'], 'Account native currency.', 'ledger freshness', 'Derived from posted postings and accounts.'),
  ('reporting.cash_flow_monthly', ARRAY['household','month','accounting class','currency'], ARRAY['income and expense totals'], 'Account native currency.', 'ledger freshness', 'Derived from income and expense postings.'),
  ('reporting.obligation_occurrences', ARRAY['household','obligation occurrence'], ARRAY['expected amounts','status'], 'Expected occurrence currency.', 'planning freshness', 'Derived from planning obligation occurrences.'),
  ('reporting.budget_variance', ARRAY['household','budget category','period'], ARRAY['planned amount','actual amount'], 'Budget allocation currency plus mapped account native amounts.', 'ledger and planning freshness', 'Combines budget mappings with posted ledger facts.'),
  ('reporting.savings_goal_progress', ARRAY['household','savings goal'], ARRAY['target','current amount'], 'Goal currency plus current native balances.', 'projection and planning freshness', 'Combines planning goals with current balance projections.'),
  ('reporting.debt_progress', ARRAY['household','debt plan'], ARRAY['monthly payment','current liability'], 'Debt plan currency plus current native liability balance.', 'projection and planning freshness', 'Combines planning debt plans with current balance projections.'),
  ('reporting.reconciliation_status', ARRAY['household','statement snapshot'], ARRAY['statement balances'], 'Statement currency.', 'source freshness', 'Derived from immutable statement snapshots.'),
  ('reporting.source_freshness', ARRAY['household','source system'], ARRAY['latest source timestamp','document count'], 'No money metric.', 'source freshness', 'Derived from source document metadata.');

CREATE INDEX account_current_balances_household_idx ON reporting.account_current_balances(household_id, as_of);
CREATE INDEX account_daily_balances_household_date_idx ON reporting.account_daily_balances(household_id, balance_date);
CREATE INDEX household_net_worth_daily_household_date_idx ON reporting.household_net_worth_daily(household_id, balance_date);
CREATE INDEX projection_drift_open_idx ON reporting.projection_drift_records(household_id, projection_key, projection_date) WHERE resolved_at IS NULL;

REVOKE ALL ON ALL TABLES IN SCHEMA reporting FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA reporting FROM PUBLIC;
GRANT USAGE ON SCHEMA reporting TO plus_one_accounting, plus_one_maintenance;
GRANT SELECT, INSERT, UPDATE ON reporting.account_current_balances TO plus_one_accounting;
GRANT SELECT, INSERT, UPDATE ON
  reporting.account_daily_balances, reporting.household_net_worth_daily,
  reporting.projection_health, reporting.projection_drift_records
TO plus_one_maintenance;
GRANT SELECT ON reporting.relation_metadata TO plus_one_maintenance;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA reporting TO plus_one_maintenance;

ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner IN SCHEMA reporting
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner IN SCHEMA reporting
  REVOKE ALL ON SEQUENCES FROM PUBLIC;

COMMIT;
RESET ROLE;
