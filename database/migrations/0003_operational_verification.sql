SET ROLE plus_one_owner;

CREATE TABLE operations.verification_tasks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id text NOT NULL CONSTRAINT verification_tasks_public_id_format CHECK (task_id ~ '^task_[0-9A-HJKMNP-TV-Z]{26}$'),
  household_id bigint NOT NULL REFERENCES operations.households(id),
  parent_task_id text,
  team text NOT NULL,
  status text NOT NULL CONSTRAINT verification_tasks_status CHECK (
    status IN (
      'created',
      'skill_selected',
      'maker_running',
      'maker_validated',
      'checker_running',
      'checker_validated',
      'revision_requested',
      'execution_pending',
      'committed',
      'readback_verified',
      'execution_failed',
      'readback_failed',
      'verified',
      'partial',
      'insufficient_evidence',
      'conflicted',
      'failed'
    )
  ),
  selected_skill_name text,
  selected_skill_version integer,
  selected_skill_hash text,
  input_schema_name text,
  input_schema_version integer,
  output_schema_name text,
  output_schema_version integer,
  runtime_policy_name text,
  runtime_policy_version integer,
  runtime_policy_snapshot jsonb,
  current_maker_artifact_id text,
  current_maker_artifact_hash text,
  current_checker_artifact_id text,
  attempt_limit integer NOT NULL CONSTRAINT verification_tasks_attempt_limit_positive CHECK (attempt_limit > 0),
  failure_category text,
  resumable boolean NOT NULL DEFAULT true,
  deadline_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT verification_tasks_public_id_unique UNIQUE (task_id),
  CONSTRAINT verification_tasks_household_task_unique UNIQUE (household_id, task_id),
  CONSTRAINT verification_tasks_skill_complete CHECK (
    (selected_skill_name IS NULL AND selected_skill_version IS NULL AND selected_skill_hash IS NULL)
    OR (
      selected_skill_name IS NOT NULL
      AND selected_skill_version > 0
      AND selected_skill_hash ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT verification_tasks_schema_complete CHECK (
    (input_schema_name IS NULL AND input_schema_version IS NULL AND output_schema_name IS NULL AND output_schema_version IS NULL)
    OR (
      input_schema_name IS NOT NULL
      AND input_schema_version > 0
      AND output_schema_name IS NOT NULL
      AND output_schema_version > 0
    )
  ),
  CONSTRAINT verification_tasks_policy_complete CHECK (
    (runtime_policy_name IS NULL AND runtime_policy_version IS NULL AND runtime_policy_snapshot IS NULL)
    OR (
      runtime_policy_name IS NOT NULL
      AND runtime_policy_version > 0
      AND runtime_policy_snapshot IS NOT NULL
    )
  ),
  CONSTRAINT verification_tasks_maker_link_complete CHECK (
    (current_maker_artifact_id IS NULL AND current_maker_artifact_hash IS NULL)
    OR (
      current_maker_artifact_id IS NOT NULL
      AND current_maker_artifact_hash ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT verification_tasks_terminal_metadata CHECK (
    (
      status IN ('verified', 'partial', 'insufficient_evidence', 'conflicted', 'failed', 'execution_failed', 'readback_failed')
      AND terminal_at IS NOT NULL
    )
    OR (
      status NOT IN ('verified', 'partial', 'insufficient_evidence', 'conflicted', 'failed', 'execution_failed', 'readback_failed')
      AND terminal_at IS NULL
    )
  )
);

ALTER TABLE operations.verification_tasks
  ADD CONSTRAINT verification_tasks_parent_fk
  FOREIGN KEY (household_id, parent_task_id)
  REFERENCES operations.verification_tasks (household_id, task_id);

CREATE TABLE operations.artifacts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  artifact_id text NOT NULL CONSTRAINT artifacts_public_id_format CHECK (artifact_id ~ '^artifact_[0-9A-HJKMNP-TV-Z]{26}$'),
  household_id bigint NOT NULL,
  task_id text NOT NULL CONSTRAINT artifacts_task_id_format CHECK (task_id ~ '^task_[0-9A-HJKMNP-TV-Z]{26}$'),
  artifact_type text NOT NULL,
  schema_name text NOT NULL,
  schema_version integer NOT NULL CONSTRAINT artifacts_schema_version_positive CHECK (schema_version > 0),
  canonicalization_version text NOT NULL CONSTRAINT artifacts_canonicalization_fixed CHECK (canonicalization_version = 'rfc8785-v1'),
  hash_algorithm text NOT NULL CONSTRAINT artifacts_hash_algorithm_fixed CHECK (hash_algorithm = 'sha256'),
  artifact_hash text NOT NULL CONSTRAINT artifacts_hash_format CHECK (artifact_hash ~ '^[0-9a-f]{64}$'),
  canonical_payload text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT artifacts_public_id_unique UNIQUE (artifact_id),
  CONSTRAINT artifacts_household_identity_pair_unique UNIQUE (household_id, artifact_id),
  CONSTRAINT artifacts_household_task_identity_unique UNIQUE (household_id, task_id, artifact_id),
  CONSTRAINT artifacts_household_task_hash_identity_unique UNIQUE (household_id, task_id, artifact_id, artifact_hash),
  CONSTRAINT artifacts_household_task_hash_unique UNIQUE (household_id, task_id, artifact_hash),
  CONSTRAINT artifacts_household_identity_unique UNIQUE (household_id, artifact_id, artifact_hash),
  CONSTRAINT artifacts_task_fk FOREIGN KEY (household_id, task_id)
    REFERENCES operations.verification_tasks (household_id, task_id)
);

ALTER TABLE operations.verification_tasks
  ADD CONSTRAINT verification_tasks_maker_artifact_fk
  FOREIGN KEY (household_id, task_id, current_maker_artifact_id, current_maker_artifact_hash)
  REFERENCES operations.artifacts (household_id, task_id, artifact_id, artifact_hash);

ALTER TABLE operations.verification_tasks
  ADD CONSTRAINT verification_tasks_checker_artifact_fk
  FOREIGN KEY (household_id, task_id, current_checker_artifact_id)
  REFERENCES operations.artifacts (household_id, task_id, artifact_id);

CREATE TABLE operations.agent_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id text NOT NULL CONSTRAINT agent_runs_public_id_format CHECK (run_id ~ '^run_[0-9A-HJKMNP-TV-Z]{26}$'),
  household_id bigint NOT NULL,
  task_id text NOT NULL,
  role text NOT NULL,
  role_version integer NOT NULL CONSTRAINT agent_runs_role_version_positive CHECK (role_version > 0),
  model_id text NOT NULL,
  runtime_policy_name text NOT NULL,
  runtime_policy_version integer NOT NULL CONSTRAINT agent_runs_policy_version_positive CHECK (runtime_policy_version > 0),
  runtime_policy_snapshot jsonb NOT NULL,
  status text NOT NULL CONSTRAINT agent_runs_status CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'timed_out')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  failure_category text,
  CONSTRAINT agent_runs_public_id_unique UNIQUE (run_id),
  CONSTRAINT agent_runs_task_identity_unique UNIQUE (household_id, task_id, run_id),
  CONSTRAINT agent_runs_policy_snapshot_identity CHECK (
    runtime_policy_snapshot #>> '{identity,policyName}' = runtime_policy_name
    AND (runtime_policy_snapshot #>> '{identity,policyVersion}')::integer = runtime_policy_version
  ),
  CONSTRAINT agent_runs_task_fk FOREIGN KEY (household_id, task_id)
    REFERENCES operations.verification_tasks (household_id, task_id)
);

CREATE TABLE operations.agent_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id bigint NOT NULL,
  task_id text NOT NULL,
  run_id text NOT NULL,
  role text NOT NULL,
  ordinal integer NOT NULL CONSTRAINT agent_attempts_ordinal_positive CHECK (ordinal > 0),
  configured_limit integer NOT NULL CONSTRAINT agent_attempts_limit_positive CHECK (configured_limit > 0),
  outcome text NOT NULL CONSTRAINT agent_attempts_outcome CHECK (
    outcome IN ('running', 'succeeded', 'schema_failed', 'model_failed', 'tool_failed', 'timed_out', 'cancelled')
  ),
  retry_category text,
  resumable boolean NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  CONSTRAINT agent_attempts_ordinal_within_limit CHECK (ordinal <= configured_limit),
  CONSTRAINT agent_attempts_unique UNIQUE (household_id, task_id, role, ordinal),
  CONSTRAINT agent_attempts_run_fk FOREIGN KEY (household_id, task_id, run_id)
    REFERENCES operations.agent_runs (household_id, task_id, run_id),
  CONSTRAINT agent_attempts_task_fk FOREIGN KEY (household_id, task_id)
    REFERENCES operations.verification_tasks (household_id, task_id)
);

CREATE TABLE operations.checker_verdicts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id bigint NOT NULL,
  task_id text NOT NULL,
  checker_artifact_id text NOT NULL,
  covered_artifact_id text NOT NULL,
  covered_artifact_hash text NOT NULL CONSTRAINT checker_verdicts_hash_format CHECK (covered_artifact_hash ~ '^[0-9a-f]{64}$'),
  verdict text NOT NULL CONSTRAINT checker_verdicts_verdict CHECK (
    verdict IN ('accepted', 'rejected', 'revision_requested', 'insufficient_evidence', 'conflicted')
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT checker_verdicts_unique UNIQUE (household_id, task_id, checker_artifact_id),
  CONSTRAINT checker_verdicts_task_fk FOREIGN KEY (household_id, task_id)
    REFERENCES operations.verification_tasks (household_id, task_id),
  CONSTRAINT checker_verdicts_checker_artifact_fk FOREIGN KEY (household_id, task_id, checker_artifact_id)
    REFERENCES operations.artifacts (household_id, task_id, artifact_id),
  CONSTRAINT checker_verdicts_covered_artifact_fk FOREIGN KEY (household_id, task_id, covered_artifact_id, covered_artifact_hash)
    REFERENCES operations.artifacts (household_id, task_id, artifact_id, artifact_hash)
);

CREATE TABLE operations.task_transitions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id bigint NOT NULL,
  task_id text NOT NULL,
  sequence integer NOT NULL CONSTRAINT task_transitions_sequence_positive CHECK (sequence > 0),
  from_status text CONSTRAINT task_transitions_from_status CHECK (
    from_status IS NULL
    OR from_status IN (
      'created',
      'skill_selected',
      'maker_running',
      'maker_validated',
      'checker_running',
      'checker_validated',
      'revision_requested',
      'execution_pending',
      'committed',
      'readback_verified',
      'execution_failed',
      'readback_failed',
      'verified',
      'partial',
      'insufficient_evidence',
      'conflicted',
      'failed'
    )
  ),
  to_status text NOT NULL CONSTRAINT task_transitions_to_status CHECK (
    to_status IN (
      'created',
      'skill_selected',
      'maker_running',
      'maker_validated',
      'checker_running',
      'checker_validated',
      'revision_requested',
      'execution_pending',
      'committed',
      'readback_verified',
      'execution_failed',
      'readback_failed',
      'verified',
      'partial',
      'insufficient_evidence',
      'conflicted',
      'failed'
    )
  ),
  reason_code text NOT NULL,
  responsible_component text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT task_transitions_unique UNIQUE (household_id, task_id, sequence),
  CONSTRAINT task_transitions_task_fk FOREIGN KEY (household_id, task_id)
    REFERENCES operations.verification_tasks (household_id, task_id)
);

CREATE FUNCTION operations.reject_immutable_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || ' is append-only';
END;
$$;

CREATE TRIGGER artifacts_immutable
BEFORE UPDATE OR DELETE ON operations.artifacts
FOR EACH ROW EXECUTE FUNCTION operations.reject_immutable_change();

CREATE TRIGGER task_transitions_immutable
BEFORE UPDATE OR DELETE ON operations.task_transitions
FOR EACH ROW EXECUTE FUNCTION operations.reject_immutable_change();

CREATE TRIGGER checker_verdicts_immutable
BEFORE UPDATE OR DELETE ON operations.checker_verdicts
FOR EACH ROW EXECUTE FUNCTION operations.reject_immutable_change();

CREATE TRIGGER agent_attempts_immutable
BEFORE DELETE ON operations.agent_attempts
FOR EACH ROW EXECUTE FUNCTION operations.reject_immutable_change();

CREATE INDEX verification_tasks_household_status_idx ON operations.verification_tasks (household_id, status, updated_at);
CREATE INDEX verification_tasks_resumable_idx ON operations.verification_tasks (updated_at)
  WHERE resumable
    AND status NOT IN ('verified', 'partial', 'insufficient_evidence', 'conflicted', 'failed', 'execution_failed', 'readback_failed');
CREATE INDEX artifacts_task_created_idx ON operations.artifacts (household_id, task_id, created_at);
CREATE INDEX task_transitions_task_sequence_idx ON operations.task_transitions (household_id, task_id, sequence);

REVOKE ALL ON operations.verification_tasks, operations.agent_runs, operations.agent_attempts FROM plus_one_query, plus_one_accounting, plus_one_planning;
GRANT DELETE ON operations.artifacts, operations.checker_verdicts, operations.task_transitions, operations.agent_attempts TO plus_one_operations;
GRANT EXECUTE ON FUNCTION operations.reject_immutable_change() TO plus_one_operations;

RESET ROLE;
