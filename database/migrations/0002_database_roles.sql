DO $roles$
DECLARE
  role_name text;
  role_password text;
  can_manage_roles boolean;
  current_role_is_superuser boolean;
  current_role_can_create_database boolean;
  target_role_is_superuser boolean;
  target_role_can_create_database boolean;
  target_role_can_create_role boolean;
  target_role_can_login boolean;
  target_role_inherits boolean;
  target_role_can_replicate boolean;
  target_role_can_bypass_rls boolean;
BEGIN
  SELECT rolcreaterole OR rolsuper, rolsuper, rolcreatedb
  INTO can_manage_roles, current_role_is_superuser, current_role_can_create_database
  FROM pg_roles
  WHERE rolname = current_user;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plus_one_owner') THEN
    IF NOT can_manage_roles THEN RAISE EXCEPTION 'plus_one_owner is missing and current role cannot create it'; END IF;
    CREATE ROLE plus_one_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;

  FOREACH role_name IN ARRAY ARRAY['plus_one_accounting', 'plus_one_planning', 'plus_one_operations', 'plus_one_query', 'plus_one_memory']
  LOOP
    role_password := current_setting('plus_one.role_password.' || replace(role_name, 'plus_one_', ''), true);
    IF role_password IS NULL OR length(role_password) < 12 THEN
      RAISE EXCEPTION 'A password of at least 12 characters is required for %', role_name;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      IF NOT can_manage_roles THEN RAISE EXCEPTION '% is missing and current role cannot create it', role_name; END IF;
      EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L', role_name, role_password);
    ELSIF can_manage_roles THEN
      SELECT rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolinherit, rolreplication, rolbypassrls
      INTO target_role_is_superuser, target_role_can_create_database, target_role_can_create_role, target_role_can_login, target_role_inherits, target_role_can_replicate, target_role_can_bypass_rls
      FROM pg_roles
      WHERE rolname = role_name;

      IF (target_role_is_superuser OR target_role_can_replicate OR target_role_can_bypass_rls) AND NOT current_role_is_superuser THEN
        RAISE EXCEPTION '% has privileged drift and requires a superuser repair', role_name;
      ELSIF target_role_can_create_database AND NOT (current_role_can_create_database OR current_role_is_superuser) THEN
        RAISE EXCEPTION '% has CREATEDB drift and requires a CREATEDB-capable repair', role_name;
      ELSIF current_role_is_superuser THEN
        EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L', role_name, role_password);
      ELSIF target_role_can_create_database THEN
        EXECUTE format('ALTER ROLE %I LOGIN NOCREATEDB NOCREATEROLE INHERIT PASSWORD %L', role_name, role_password);
      ELSIF target_role_can_create_role OR NOT target_role_can_login OR NOT target_role_inherits THEN
        EXECUTE format('ALTER ROLE %I LOGIN NOCREATEROLE INHERIT PASSWORD %L', role_name, role_password);
      ELSE
        EXECUTE format('ALTER ROLE %I PASSWORD %L', role_name, role_password);
      END IF;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plus_one_maintenance') THEN
    IF NOT can_manage_roles THEN RAISE EXCEPTION 'plus_one_maintenance is missing and current role cannot create it'; END IF;
    CREATE ROLE plus_one_maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    JOIN pg_roles member_role ON member_role.oid = membership.member
    WHERE granted_role.rolname = 'plus_one_owner'
      AND member_role.rolname = 'plus_one_migrator'
      AND membership.set_option
  ) THEN
    IF NOT can_manage_roles THEN RAISE EXCEPTION 'plus_one_migrator cannot assume plus_one_owner'; END IF;
    GRANT plus_one_owner TO plus_one_migrator WITH SET TRUE;
  END IF;
END
$roles$;

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

DO $role_settings$
DECLARE
  can_manage_roles boolean;
BEGIN
  SELECT rolcreaterole OR rolsuper INTO can_manage_roles FROM pg_roles WHERE rolname = current_user;

  IF can_manage_roles THEN
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
  END IF;
END
$role_settings$;
