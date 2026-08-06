SET ROLE plus_one_owner;
BEGIN;
SET LOCAL search_path = pg_catalog, reporting, planning, operations;

DROP TRIGGER IF EXISTS budget_versions_no_active_overlap ON planning.budget_versions;
DROP FUNCTION IF EXISTS planning.prevent_budget_version_overlap();

CREATE OR REPLACE VIEW reporting.budget_variance AS
SELECT household.household_id, scope.scope_key, category.category_key,
  allocation.period_start, allocation.period_end, allocation.amount AS planned_amount,
  allocation.currency AS planned_currency,
  coalesce(sum(CASE WHEN posting.direction = account.normal_balance
    THEN posting.account_native_amount ELSE -posting.account_native_amount END), 0)::text AS actual_amount,
  version.id::text AS budget_version_id,
  version.name AS budget_name
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
 AND mapping.valid_from <= allocation.period_end
 AND (mapping.valid_to IS NULL OR mapping.valid_to >= allocation.period_start)
LEFT JOIN accounting.accounts account
  ON account.household_id = mapping.household_id AND account.id = mapping.account_id
LEFT JOIN accounting.journals journal
  ON journal.household_id = mapping.household_id
 AND journal.effective_on BETWEEN allocation.period_start AND allocation.period_end
LEFT JOIN accounting.postings posting
  ON posting.household_id = journal.household_id
 AND posting.journal_id = journal.id
 AND posting.account_id = mapping.account_id
GROUP BY household.household_id, scope.scope_key, category.category_key,
  allocation.period_start, allocation.period_end, allocation.amount, allocation.currency,
  version.id, version.name;

UPDATE reporting.relation_metadata
SET grain = ARRAY['household', 'budget version', 'budget category', 'period'],
    source_semantics = 'Combines budget-version allocations with budget mappings and posted ledger facts.'
WHERE relation_name = 'reporting.budget_variance';

COMMIT;
RESET ROLE;
