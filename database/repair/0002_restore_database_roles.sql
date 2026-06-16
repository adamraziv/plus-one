BEGIN;
SET LOCAL ROLE plus_one_owner;

REVOKE ALL ON SCHEMA accounting, ingestion, planning, operations, reporting, mastra_memory FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA accounting, ingestion, planning, operations, reporting, mastra_memory FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA accounting, ingestion, planning, operations, reporting, mastra_memory FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA accounting, ingestion, planning, operations, reporting, mastra_memory FROM PUBLIC;

GRANT USAGE ON SCHEMA accounting, ingestion TO plus_one_accounting;
GRANT USAGE ON SCHEMA planning TO plus_one_planning;
GRANT USAGE ON SCHEMA operations TO plus_one_operations;
GRANT USAGE ON SCHEMA reporting TO plus_one_query;
GRANT USAGE ON SCHEMA mastra_memory TO plus_one_memory;
GRANT USAGE ON SCHEMA operations, reporting TO plus_one_maintenance;

GRANT SELECT, INSERT, UPDATE ON operations.households TO plus_one_operations;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON operations.households FROM plus_one_operations;
GRANT SELECT ON operations.currency_metadata TO plus_one_operations;
GRANT USAGE, SELECT ON SEQUENCE operations.households_id_seq TO plus_one_operations;
GRANT EXECUTE ON FUNCTION operations.is_valid_iana_timezone(text) TO plus_one_operations;
GRANT EXECUTE ON FUNCTION operations.amount_matches_currency_scale(operations.decimal_amount, operations.currency_code)
  TO plus_one_accounting, plus_one_planning, plus_one_operations;

REVOKE ALL ON operations.households, operations.currency_metadata, operations.schema_migrations FROM plus_one_query;

ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner IN SCHEMA operations REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner IN SCHEMA operations GRANT SELECT, INSERT, UPDATE ON TABLES TO plus_one_operations;
ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner IN SCHEMA operations GRANT USAGE, SELECT ON SEQUENCES TO plus_one_operations;

COMMIT;
