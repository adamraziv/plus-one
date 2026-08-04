SET ROLE plus_one_owner;

CREATE TABLE operations.pending_interactions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  interaction_id text NOT NULL,
  kind text NOT NULL CHECK (kind = 'working_memory_confirmation'),
  household_id bigint NOT NULL REFERENCES operations.households(id),
  conversation_id text NOT NULL,
  speaker_principal_ref text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending','resolving','applied','rejected','expired','stale','failed')
  ),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  resolution_external_message_id text,
  resolution_code text CHECK (
    resolution_code IS NULL OR resolution_code ~ '^[a-z0-9_]{1,160}$'
  ),
  resolution_response jsonb CHECK (
    resolution_response IS NULL OR jsonb_typeof(resolution_response) = 'object'
  ),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pending_interactions_public_unique UNIQUE (interaction_id),
  CONSTRAINT pending_interactions_expiry CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX pending_interactions_open_scope_unique
  ON operations.pending_interactions
    (household_id, conversation_id, speaker_principal_ref, kind)
  WHERE status IN ('pending', 'resolving');

CREATE INDEX pending_interactions_scope_status_idx
  ON operations.pending_interactions
    (household_id, conversation_id, speaker_principal_ref, status, expires_at);

CREATE UNIQUE INDEX pending_interactions_resolution_message_unique
  ON operations.pending_interactions
    (household_id, conversation_id, resolution_external_message_id)
  WHERE resolution_external_message_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON operations.pending_interactions TO plus_one_operations;
GRANT USAGE, SELECT ON SEQUENCE operations.pending_interactions_id_seq TO plus_one_operations;
REVOKE ALL ON operations.pending_interactions FROM
  plus_one_query, plus_one_accounting, plus_one_planning, plus_one_memory;
REVOKE ALL ON SEQUENCE operations.pending_interactions_id_seq FROM
  plus_one_query, plus_one_accounting, plus_one_planning, plus_one_memory;

RESET ROLE;
