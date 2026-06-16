#!/usr/bin/env bash
set -euo pipefail

: "${PLUS_ONE_MIGRATOR_PASSWORD:?PLUS_ONE_MIGRATOR_PASSWORD is required}"

psql --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=migrator_password="$PLUS_ONE_MIGRATOR_PASSWORD" <<'SQL'
SELECT format(
  'CREATE ROLE plus_one_migrator LOGIN CREATEROLE NOCREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'migrator_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plus_one_migrator')
\gexec

SELECT format('ALTER DATABASE %I OWNER TO plus_one_migrator', current_database())
\gexec
SQL
