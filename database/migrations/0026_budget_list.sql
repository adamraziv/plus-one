SET ROLE plus_one_owner;
BEGIN;
SET LOCAL search_path = pg_catalog, reporting, planning, operations;

CREATE VIEW reporting.budget_list AS
SELECT household.household_id,
  version.id::text AS budget_version_id,
  version.name AS budget_name,
  scope.scope_key,
  version.valid_from,
  version.valid_to
FROM planning.budget_versions version
JOIN planning.budget_scopes scope
  ON scope.household_id = version.household_id AND scope.id = version.scope_id
JOIN operations.households household ON household.id = version.household_id
WHERE version.archived_at IS NULL AND scope.archived_at IS NULL;

INSERT INTO reporting.relation_metadata
  (relation_name, grain, metrics, currency_behavior, freshness, source_semantics)
VALUES
  ('reporting.budget_list', ARRAY['household','budget version'], ARRAY['budget attributes'], 'No money metric.', 'planning freshness', 'Derived from active planning budget versions and scopes.');

GRANT SELECT ON reporting.budget_list TO plus_one_query;

COMMIT;
RESET ROLE;
