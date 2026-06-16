SELECT
  (
    SELECT bool_and(NOT has_schema_privilege('public', schema_name, 'USAGE'))
    FROM unnest(ARRAY['accounting', 'ingestion', 'planning', 'operations', 'reporting', 'mastra_memory']) AS schema_name
  ) AS public_schema_access_revoked,
  has_table_privilege('plus_one_operations', 'operations.households', 'SELECT,INSERT,UPDATE')
    AND NOT has_table_privilege('plus_one_operations', 'operations.households', 'DELETE')
    AS operations_household_access_restored,
  NOT has_table_privilege('plus_one_query', 'operations.households', 'SELECT')
    AS query_base_access_denied,
  (SELECT rolconfig @> ARRAY['default_transaction_read_only=on'] FROM pg_roles WHERE rolname = 'plus_one_query')
    AS query_read_only;
