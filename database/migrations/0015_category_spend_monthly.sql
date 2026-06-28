SET ROLE plus_one_owner;
BEGIN;
SET LOCAL search_path = pg_catalog, reporting, operations;

CREATE VIEW reporting.category_spend_monthly AS
SELECT household.household_id,
  date_trunc('month', journal.effective_on)::date AS month_start,
  account.account_id,
  account.name AS category_name,
  sum(CASE WHEN posting.direction = account.normal_balance
    THEN posting.account_native_amount ELSE -posting.account_native_amount END)::text AS native_amount,
  account.native_currency
FROM accounting.postings posting
JOIN accounting.journals journal
  ON journal.household_id = posting.household_id AND journal.id = posting.journal_id
JOIN accounting.accounts account
  ON account.household_id = posting.household_id AND account.id = posting.account_id
JOIN operations.households household ON household.id = posting.household_id
WHERE account.accounting_class = 'expense'
GROUP BY household.household_id, date_trunc('month', journal.effective_on)::date,
  account.account_id, account.name, account.native_currency;

INSERT INTO reporting.relation_metadata
  (relation_name, grain, metrics, currency_behavior, freshness, source_semantics)
VALUES
  ('reporting.category_spend_monthly', ARRAY['household','month','category'], ARRAY['expense totals'], 'Account native currency.', 'ledger freshness', 'Derived from expense postings grouped by month and category.')
ON CONFLICT (relation_name) DO NOTHING;

GRANT SELECT ON reporting.category_spend_monthly TO plus_one_query;

COMMIT;
RESET ROLE;
