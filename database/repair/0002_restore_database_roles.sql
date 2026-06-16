DO $owner_membership$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    JOIN pg_roles member_role ON member_role.oid = membership.member
    WHERE granted_role.rolname = 'plus_one_owner'
      AND member_role.rolname = 'plus_one_migrator'
      AND membership.set_option
  ) THEN
    GRANT plus_one_owner TO plus_one_migrator WITH SET TRUE;
  END IF;
END
$owner_membership$;

DO $database_privileges$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO plus_one_owner, plus_one_migrator, plus_one_accounting, plus_one_planning, plus_one_operations, plus_one_query, plus_one_memory',
    current_database()
  );
  EXECUTE format('GRANT CREATE ON DATABASE %I TO plus_one_owner', current_database());
END
$database_privileges$;

REVOKE ALL ON SCHEMA accounting, ingestion, planning, operations, reporting, mastra_memory FROM PUBLIC;
GRANT USAGE ON SCHEMA accounting, ingestion TO plus_one_accounting;
GRANT USAGE ON SCHEMA planning TO plus_one_planning;
GRANT USAGE ON SCHEMA operations TO plus_one_operations;
GRANT USAGE ON SCHEMA reporting TO plus_one_query;
GRANT USAGE ON SCHEMA mastra_memory TO plus_one_memory;
GRANT USAGE ON SCHEMA operations, reporting TO plus_one_maintenance;
GRANT USAGE ON SCHEMA operations TO plus_one_migrator;

REVOKE ALL ON ALL TABLES IN SCHEMA accounting, ingestion, planning, operations, reporting, mastra_memory FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA accounting, ingestion, planning, operations, reporting, mastra_memory FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA accounting, ingestion, planning, operations, reporting, mastra_memory FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA operations FROM plus_one_accounting, plus_one_planning, plus_one_query, plus_one_memory;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA operations FROM plus_one_accounting, plus_one_planning, plus_one_query, plus_one_memory;

GRANT SELECT, INSERT, UPDATE ON operations.households TO plus_one_operations;
GRANT SELECT, INSERT ON operations.schema_migrations TO plus_one_migrator;
GRANT SELECT ON operations.currency_metadata TO plus_one_operations;
GRANT USAGE, SELECT ON SEQUENCE operations.households_id_seq TO plus_one_operations;
GRANT EXECUTE ON FUNCTION operations.is_valid_iana_timezone(text) TO plus_one_operations;
GRANT EXECUTE ON FUNCTION operations.amount_matches_currency_scale(operations.decimal_amount, operations.currency_code)
  TO plus_one_accounting, plus_one_planning, plus_one_operations;

ALTER SCHEMA accounting OWNER TO plus_one_owner;
ALTER SCHEMA ingestion OWNER TO plus_one_owner;
ALTER SCHEMA planning OWNER TO plus_one_owner;
ALTER SCHEMA operations OWNER TO plus_one_owner;
ALTER SCHEMA reporting OWNER TO plus_one_owner;
ALTER SCHEMA mastra_memory OWNER TO plus_one_owner;

SET ROLE plus_one_owner;

ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner IN SCHEMA accounting REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner IN SCHEMA ingestion REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner IN SCHEMA planning REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner IN SCHEMA operations REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner IN SCHEMA reporting REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner IN SCHEMA mastra_memory REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner IN SCHEMA operations GRANT SELECT, INSERT, UPDATE ON TABLES TO plus_one_operations;
ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner IN SCHEMA operations GRANT USAGE, SELECT ON SEQUENCES TO plus_one_operations;

RESET ROLE;

ALTER DOMAIN operations.currency_code OWNER TO plus_one_owner;
ALTER DOMAIN operations.decimal_amount OWNER TO plus_one_owner;
ALTER DOMAIN operations.utc_instant OWNER TO plus_one_owner;
ALTER DOMAIN operations.local_date OWNER TO plus_one_owner;
ALTER TABLE operations.schema_migrations OWNER TO plus_one_owner;
ALTER TABLE operations.currency_metadata OWNER TO plus_one_owner;
ALTER TABLE operations.households OWNER TO plus_one_owner;
ALTER SEQUENCE operations.households_id_seq OWNER TO plus_one_owner;
ALTER FUNCTION operations.is_valid_iana_timezone(text) OWNER TO plus_one_owner;
ALTER FUNCTION operations.amount_matches_currency_scale(operations.decimal_amount, operations.currency_code) OWNER TO plus_one_owner;

ALTER ROLE plus_one_accounting SET search_path = pg_catalog, accounting, ingestion;
ALTER ROLE plus_one_planning SET search_path = pg_catalog, planning;
ALTER ROLE plus_one_operations SET search_path = pg_catalog, operations;
ALTER ROLE plus_one_query SET search_path = pg_catalog, reporting;
ALTER ROLE plus_one_memory SET search_path = pg_catalog, mastra_memory;
ALTER ROLE plus_one_accounting SET statement_timeout = '5s';
ALTER ROLE plus_one_planning SET statement_timeout = '5s';
ALTER ROLE plus_one_operations SET statement_timeout = '5s';
ALTER ROLE plus_one_query SET statement_timeout = '5s';
ALTER ROLE plus_one_memory SET statement_timeout = '5s';
ALTER ROLE plus_one_accounting SET lock_timeout = '1s';
ALTER ROLE plus_one_planning SET lock_timeout = '1s';
ALTER ROLE plus_one_operations SET lock_timeout = '1s';
ALTER ROLE plus_one_query SET lock_timeout = '1s';
ALTER ROLE plus_one_memory SET lock_timeout = '1s';
ALTER ROLE plus_one_accounting SET idle_in_transaction_session_timeout = '5s';
ALTER ROLE plus_one_planning SET idle_in_transaction_session_timeout = '5s';
ALTER ROLE plus_one_operations SET idle_in_transaction_session_timeout = '5s';
ALTER ROLE plus_one_query SET idle_in_transaction_session_timeout = '5s';
ALTER ROLE plus_one_memory SET idle_in_transaction_session_timeout = '5s';
ALTER ROLE plus_one_query SET default_transaction_read_only = on;
ALTER ROLE plus_one_migrator NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
