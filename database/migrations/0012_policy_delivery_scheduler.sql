SET ROLE plus_one_owner;

CREATE TABLE operations.channel_conversations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id text NOT NULL CONSTRAINT channel_conversations_public_id_format CHECK (
    conversation_id ~ '^conversation_[0-9A-HJKMNP-TV-Z]{26}$'
  ),
  household_id bigint NOT NULL REFERENCES operations.households(id),
  channel text NOT NULL CONSTRAINT channel_conversations_channel CHECK (channel IN ('telegram', 'slack')),
  channel_type text NOT NULL CONSTRAINT channel_conversations_channel_type CHECK (
    channel_type IN ('direct', 'group', 'channel', 'thread')
  ),
  external_conversation_id text NOT NULL,
  external_thread_id text NOT NULL DEFAULT '',
  destination jsonb NOT NULL CONSTRAINT channel_conversations_destination_object CHECK (
    jsonb_typeof(destination) = 'object'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT channel_conversations_public_unique UNIQUE (conversation_id),
  CONSTRAINT channel_conversations_household_public_unique UNIQUE (household_id, conversation_id),
  CONSTRAINT channel_conversations_platform_unique UNIQUE (
    household_id, channel, external_conversation_id, external_thread_id
  )
);

CREATE TABLE operations.channel_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id bigint NOT NULL REFERENCES operations.channel_conversations(id),
  household_id bigint NOT NULL REFERENCES operations.households(id),
  direction text NOT NULL CONSTRAINT channel_messages_direction CHECK (direction IN ('inbound', 'outbound')),
  channel text NOT NULL CONSTRAINT channel_messages_channel CHECK (channel IN ('telegram', 'slack')),
  external_message_id text NOT NULL,
  delivery_id bigint,
  body text NOT NULL,
  speaker jsonb NOT NULL CONSTRAINT channel_messages_speaker_object CHECK (jsonb_typeof(speaker) = 'object'),
  attachments jsonb NOT NULL CONSTRAINT channel_messages_attachments_array CHECK (jsonb_typeof(attachments) = 'array'),
  metadata jsonb NOT NULL CONSTRAINT channel_messages_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT channel_messages_platform_unique UNIQUE (household_id, channel, external_message_id)
);

CREATE TABLE operations.outbound_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id text NOT NULL CONSTRAINT outbound_deliveries_public_id_format CHECK (
    delivery_id ~ '^delivery_[0-9A-HJKMNP-TV-Z]{26}$'
  ),
  household_id bigint NOT NULL REFERENCES operations.households(id),
  conversation_id bigint NOT NULL REFERENCES operations.channel_conversations(id),
  idempotency_key text NOT NULL,
  response_hash text NOT NULL CONSTRAINT outbound_deliveries_response_hash_format CHECK (
    response_hash ~ '^[0-9a-f]{64}$'
  ),
  final_response jsonb,
  status text NOT NULL CONSTRAINT outbound_deliveries_status CHECK (
    status IN ('pending', 'sending', 'delivered', 'failed', 'ambiguous')
  ),
  channel text NOT NULL CONSTRAINT outbound_deliveries_channel CHECK (channel IN ('telegram', 'slack')),
  destination jsonb NOT NULL CONSTRAINT outbound_deliveries_destination_object CHECK (
    jsonb_typeof(destination) = 'object'
  ),
  platform_message_id text,
  attempt_count integer NOT NULL CONSTRAINT outbound_deliveries_attempt_count_nonnegative CHECK (
    attempt_count >= 0
  ),
  failure_category text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT outbound_deliveries_public_unique UNIQUE (delivery_id),
  CONSTRAINT outbound_deliveries_idempotency_unique UNIQUE (household_id, idempotency_key)
);

CREATE TABLE operations.scheduled_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id text NOT NULL CONSTRAINT scheduled_jobs_public_id_format CHECK (
    job_id ~ '^job_[0-9A-HJKMNP-TV-Z]{26}$'
  ),
  household_id bigint NOT NULL REFERENCES operations.households(id),
  version integer NOT NULL CONSTRAINT scheduled_jobs_version_positive CHECK (version > 0),
  target_kind text NOT NULL CONSTRAINT scheduled_jobs_target_kind CHECK (target_kind IN ('orchestrator', 'team_lead')),
  target_team text,
  purpose text NOT NULL,
  schedule_kind text NOT NULL CONSTRAINT scheduled_jobs_schedule_kind CHECK (schedule_kind = 'external'),
  schedule_expression text NOT NULL,
  timezone text NOT NULL CONSTRAINT scheduled_jobs_timezone_valid CHECK (operations.is_valid_iana_timezone(timezone)),
  next_eligible_run_at timestamptz NOT NULL,
  required_context_schema_name text NOT NULL,
  required_context_schema_version integer NOT NULL CONSTRAINT scheduled_jobs_context_schema_version_positive CHECK (
    required_context_schema_version > 0
  ),
  required_context jsonb NOT NULL,
  delivery_behavior jsonb NOT NULL CONSTRAINT scheduled_jobs_delivery_behavior_object CHECK (
    jsonb_typeof(delivery_behavior) = 'object'
  ),
  overlap_policy text NOT NULL CONSTRAINT scheduled_jobs_overlap_policy CHECK (overlap_policy IN ('skip', 'allow')),
  missed_run_policy text NOT NULL CONSTRAINT scheduled_jobs_missed_run_policy CHECK (
    missed_run_policy IN ('skip', 'run_once', 'bounded_catch_up')
  ),
  timeout_ms integer NOT NULL CONSTRAINT scheduled_jobs_timeout_positive CHECK (timeout_ms > 0),
  max_retries integer NOT NULL CONSTRAINT scheduled_jobs_max_retries_nonnegative CHECK (max_retries >= 0),
  enabled boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT scheduled_jobs_public_unique UNIQUE (job_id),
  CONSTRAINT scheduled_jobs_household_public_unique UNIQUE (household_id, job_id),
  CONSTRAINT scheduled_jobs_target_team_required CHECK (
    (target_kind = 'orchestrator' AND target_team IS NULL)
    OR (target_kind = 'team_lead' AND target_team IS NOT NULL)
  )
);

CREATE TABLE operations.scheduled_job_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id bigint NOT NULL REFERENCES operations.households(id),
  job_id text NOT NULL,
  version integer NOT NULL CONSTRAINT scheduled_job_changes_version_positive CHECK (version > 0),
  rationale text NOT NULL,
  previous_state jsonb,
  next_state jsonb NOT NULL CONSTRAINT scheduled_job_changes_next_state_object CHECK (
    jsonb_typeof(next_state) = 'object'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT scheduled_job_changes_job_fk FOREIGN KEY (household_id, job_id)
    REFERENCES operations.scheduled_jobs (household_id, job_id)
);

CREATE TABLE operations.scheduled_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurrence_id text NOT NULL CONSTRAINT scheduled_runs_public_id_format CHECK (
    occurrence_id ~ '^occurrence_[0-9A-HJKMNP-TV-Z]{26}$'
  ),
  household_id bigint NOT NULL REFERENCES operations.households(id),
  job_id text NOT NULL,
  job_version integer NOT NULL CONSTRAINT scheduled_runs_job_version_positive CHECK (job_version > 0),
  run_key text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL CONSTRAINT scheduled_runs_status CHECK (
    status IN ('claimed', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled', 'skipped')
  ),
  attempt_count integer NOT NULL CONSTRAINT scheduled_runs_attempt_count_nonnegative CHECK (attempt_count >= 0),
  task_id text CONSTRAINT scheduled_runs_task_id_format CHECK (
    task_id IS NULL OR task_id ~ '^task_[0-9A-HJKMNP-TV-Z]{26}$'
  ),
  delivery_id text CONSTRAINT scheduled_runs_delivery_id_format CHECK (
    delivery_id IS NULL OR delivery_id ~ '^delivery_[0-9A-HJKMNP-TV-Z]{26}$'
  ),
  failure_category text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT scheduled_runs_public_unique UNIQUE (occurrence_id),
  CONSTRAINT scheduled_runs_run_key_unique UNIQUE (household_id, run_key),
  CONSTRAINT scheduled_runs_job_fk FOREIGN KEY (household_id, job_id)
    REFERENCES operations.scheduled_jobs (household_id, job_id)
);

CREATE TRIGGER scheduled_job_changes_immutable
BEFORE UPDATE OR DELETE ON operations.scheduled_job_changes
FOR EACH ROW EXECUTE FUNCTION operations.reject_immutable_change();

CREATE INDEX channel_messages_conversation_created_idx
  ON operations.channel_messages (conversation_id, created_at);
CREATE INDEX outbound_deliveries_status_updated_idx
  ON operations.outbound_deliveries (status, updated_at);
CREATE INDEX scheduled_jobs_due_idx
  ON operations.scheduled_jobs (next_eligible_run_at)
  WHERE enabled;
CREATE INDEX scheduled_runs_job_status_idx
  ON operations.scheduled_runs (household_id, job_id, status, scheduled_for);

GRANT SELECT, INSERT, UPDATE ON operations.channel_conversations TO plus_one_operations;
GRANT SELECT, INSERT, UPDATE ON operations.channel_messages TO plus_one_operations;
GRANT SELECT, INSERT, UPDATE ON operations.outbound_deliveries TO plus_one_operations;
GRANT SELECT, INSERT, UPDATE ON operations.scheduled_jobs TO plus_one_operations;
GRANT SELECT, INSERT, UPDATE, DELETE ON operations.scheduled_job_changes TO plus_one_operations;
GRANT SELECT, INSERT, UPDATE ON operations.scheduled_runs TO plus_one_operations;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA operations TO plus_one_operations;

REVOKE ALL ON operations.channel_conversations, operations.channel_messages, operations.outbound_deliveries,
  operations.scheduled_jobs, operations.scheduled_job_changes, operations.scheduled_runs
  FROM plus_one_query, plus_one_accounting, plus_one_planning, plus_one_memory;

RESET ROLE;
