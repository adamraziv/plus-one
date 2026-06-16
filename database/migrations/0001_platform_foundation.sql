CREATE SCHEMA accounting;
CREATE SCHEMA ingestion;
CREATE SCHEMA planning;
CREATE SCHEMA operations;
CREATE SCHEMA reporting;
CREATE SCHEMA mastra_memory;

CREATE DOMAIN operations.currency_code AS text
  CHECK (VALUE ~ '^[A-Z][A-Z0-9]{2,11}$');

CREATE DOMAIN operations.decimal_amount AS numeric(38, 12);
CREATE DOMAIN operations.utc_instant AS timestamptz;
CREATE DOMAIN operations.local_date AS date;

CREATE TABLE operations.schema_migrations (
  filename text PRIMARY KEY,
  checksum text NOT NULL CONSTRAINT schema_migrations_checksum_format CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  duration_ms integer NOT NULL CONSTRAINT schema_migrations_duration_nonnegative CHECK (duration_ms >= 0)
);

CREATE TABLE operations.currency_metadata (
  currency_code operations.currency_code PRIMARY KEY,
  display_name text NOT NULL,
  decimal_scale smallint NOT NULL CONSTRAINT currency_metadata_scale_range CHECK (decimal_scale BETWEEN 0 AND 12),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO operations.currency_metadata (currency_code, display_name, decimal_scale) VALUES
  ('CNY', 'Chinese Yuan', 2),
  ('EUR', 'Euro', 2),
  ('GBP', 'Pound Sterling', 2),
  ('JPY', 'Japanese Yen', 0),
  ('USD', 'US Dollar', 2);

CREATE FUNCTION operations.is_valid_iana_timezone(candidate text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = candidate);
$$;

CREATE FUNCTION operations.amount_matches_currency_scale(
  amount operations.decimal_amount,
  currency operations.currency_code
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, operations
AS $$
  SELECT scale(trim_scale(amount)) <= decimal_scale
  FROM operations.currency_metadata
  WHERE currency_code = currency AND is_active;
$$;

CREATE TABLE operations.households (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id text NOT NULL CONSTRAINT households_public_id_format CHECK (household_id ~ '^hh_[0-9A-HJKMNP-TV-Z]{26}$'),
  lifecycle_state text NOT NULL DEFAULT 'active' CONSTRAINT households_lifecycle_state CHECK (lifecycle_state IN ('active', 'archived')),
  reporting_currency operations.currency_code NOT NULL REFERENCES operations.currency_metadata(currency_code),
  reporting_timezone text NOT NULL CONSTRAINT households_reporting_timezone CHECK (operations.is_valid_iana_timezone(reporting_timezone)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz,
  CONSTRAINT households_public_id_unique UNIQUE (household_id),
  CONSTRAINT households_archive_state_consistent CHECK (
    (lifecycle_state = 'active' AND archived_at IS NULL)
    OR (lifecycle_state = 'archived' AND archived_at IS NOT NULL)
  )
);
