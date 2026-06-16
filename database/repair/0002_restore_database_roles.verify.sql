DO $verify_database_roles$
DECLARE
  failures text[] := ARRAY[]::text[];
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname IN (
      'plus_one_accounting',
      'plus_one_memory',
      'plus_one_migrator',
      'plus_one_operations',
      'plus_one_owner',
      'plus_one_planning',
      'plus_one_query'
    )
      AND rolsuper
  ) THEN
    failures := array_append(failures, 'unexpected superuser role');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'plus_one_migrator'
      AND (rolcreaterole OR rolinherit)
  ) THEN
    failures := array_append(failures, 'migrator is not hardened');
  END IF;

  IF NOT pg_has_role('plus_one_migrator', 'plus_one_owner', 'MEMBER') THEN
    failures := array_append(failures, 'migrator is not an owner member');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_namespace
    WHERE nspname IN ('accounting', 'ingestion', 'planning', 'operations', 'reporting', 'mastra_memory')
      AND pg_get_userbyid(nspowner) <> 'plus_one_owner'
  ) THEN
    failures := array_append(failures, 'schema owner mismatch');
  END IF;

  IF has_schema_privilege('public', 'operations', 'USAGE') THEN
    failures := array_append(failures, 'public has operations schema usage');
  END IF;

  IF NOT has_table_privilege('plus_one_operations', 'operations.households', 'SELECT,INSERT,UPDATE') THEN
    failures := array_append(failures, 'operations lacks household write privileges');
  END IF;

  IF has_table_privilege('plus_one_query', 'operations.households', 'SELECT') THEN
    failures := array_append(failures, 'query can read operations households');
  END IF;

  IF has_function_privilege('public', 'operations.is_valid_iana_timezone(text)', 'EXECUTE') THEN
    failures := array_append(failures, 'public can execute operations timezone validator');
  END IF;

  IF array_length(failures, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'database role repair verification failed: %', array_to_string(failures, ', ');
  END IF;
END
$verify_database_roles$;
