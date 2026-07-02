SET ROLE plus_one_owner;

CREATE TABLE operations.channel_principals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel text NOT NULL CONSTRAINT channel_principals_channel CHECK (channel IN ('telegram', 'slack')),
  external_user_id text NOT NULL,
  external_chat_id text NOT NULL,
  household_id bigint NOT NULL REFERENCES operations.households(id),
  display_name text,
  username text,
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_by text NOT NULL,
  revoked_at timestamptz,
  metadata jsonb NOT NULL CONSTRAINT channel_principals_metadata_object CHECK (
    jsonb_typeof(metadata) = 'object'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX channel_principals_active_unique
  ON operations.channel_principals (channel, external_user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX channel_principals_household_idx
  ON operations.channel_principals (household_id, channel, revoked_at);

CREATE TABLE operations.channel_pairing_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel text NOT NULL CONSTRAINT channel_pairing_requests_channel CHECK (channel IN ('telegram', 'slack')),
  external_user_id text NOT NULL,
  external_chat_id text NOT NULL,
  code_hash text NOT NULL CONSTRAINT channel_pairing_requests_code_hash_format CHECK (
    code_hash ~ '^[0-9a-f]{64}$'
  ),
  code_salt text NOT NULL CONSTRAINT channel_pairing_requests_code_salt_format CHECK (
    code_salt ~ '^[0-9a-f]{32}$'
  ),
  display_name text,
  username text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  last_sent_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  failed_approval_attempt_count integer NOT NULL DEFAULT 0
    CONSTRAINT channel_pairing_requests_failed_attempt_count_nonnegative CHECK (
      failed_approval_attempt_count >= 0
    ),
  approval_locked_until timestamptz,
  metadata jsonb NOT NULL CONSTRAINT channel_pairing_requests_metadata_object CHECK (
    jsonb_typeof(metadata) = 'object'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX channel_pairing_requests_active_user_unique
  ON operations.channel_pairing_requests (channel, external_user_id)
  WHERE consumed_at IS NULL;

CREATE INDEX channel_pairing_requests_pending_idx
  ON operations.channel_pairing_requests (channel, consumed_at, expires_at);

GRANT SELECT, INSERT, UPDATE ON operations.channel_principals TO plus_one_operations;
GRANT SELECT, INSERT, UPDATE ON operations.channel_pairing_requests TO plus_one_operations;
GRANT USAGE, SELECT ON SEQUENCE operations.channel_principals_id_seq TO plus_one_operations;
GRANT USAGE, SELECT ON SEQUENCE operations.channel_pairing_requests_id_seq TO plus_one_operations;

REVOKE ALL ON operations.channel_principals, operations.channel_pairing_requests
  FROM plus_one_query, plus_one_accounting, plus_one_planning, plus_one_memory;
REVOKE ALL ON SEQUENCE operations.channel_principals_id_seq,
  operations.channel_pairing_requests_id_seq
  FROM plus_one_query, plus_one_accounting, plus_one_planning, plus_one_memory;

RESET ROLE;
