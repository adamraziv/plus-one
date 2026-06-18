SET ROLE plus_one_owner;

CREATE TABLE operations.external_confirmations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  confirmation_id text NOT NULL CONSTRAINT external_confirmations_public_id_format
    CHECK (confirmation_id ~ '^confirm_[0-9A-HJKMNP-TV-Z]{26}$'),
  household_id bigint NOT NULL REFERENCES operations.households(id),
  task_id text NOT NULL,
  checked_proposal_id text NOT NULL,
  checked_proposal_hash text NOT NULL CONSTRAINT external_confirmations_hash_format
    CHECK (checked_proposal_hash ~ '^[0-9a-f]{64}$'),
  principal_id text NOT NULL CONSTRAINT external_confirmations_principal_nonempty
    CHECK (btrim(principal_id) <> ''),
  channel text NOT NULL CONSTRAINT external_confirmations_channel
    CHECK (channel IN ('telegram','slack','other')),
  channel_reference text NOT NULL CONSTRAINT external_confirmations_reference_nonempty
    CHECK (btrim(channel_reference) <> ''),
  confirmed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT external_confirmations_public_unique UNIQUE (confirmation_id),
  CONSTRAINT external_confirmations_household_public_unique UNIQUE (household_id, confirmation_id),
  CONSTRAINT external_confirmations_household_internal_unique UNIQUE (household_id, id),
  CONSTRAINT external_confirmations_exact_artifact_fk
    FOREIGN KEY (household_id, task_id, checked_proposal_id, checked_proposal_hash)
    REFERENCES operations.artifacts(household_id, task_id, artifact_id, artifact_hash)
);

CREATE TABLE operations.mutation_commands (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  command_id text NOT NULL CONSTRAINT mutation_commands_public_id_format
    CHECK (command_id ~ '^command_[0-9A-HJKMNP-TV-Z]{26}$'),
  household_id bigint NOT NULL,
  task_id text NOT NULL,
  command_type text NOT NULL CONSTRAINT mutation_commands_type_format
    CHECK (command_type ~ '^[a-z][a-z0-9_]{2,63}$'),
  checked_proposal_id text NOT NULL,
  checked_proposal_hash text NOT NULL CONSTRAINT mutation_commands_hash_format
    CHECK (checked_proposal_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL CONSTRAINT mutation_commands_idempotency_format
    CHECK (idempotency_key ~ '^idem_[0-9A-HJKMNP-TV-Z]{26,120}$'),
  confirmation_required boolean NOT NULL DEFAULT false,
  confirmation_id bigint,
  payload_schema_name text NOT NULL CONSTRAINT mutation_commands_schema_name_nonempty
    CHECK (btrim(payload_schema_name) <> ''),
  payload_schema_version integer NOT NULL CONSTRAINT mutation_commands_schema_version_positive
    CHECK (payload_schema_version > 0),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'registered' CONSTRAINT mutation_commands_status CHECK (
    status IN ('registered','execution_pending','committed','readback_verified',
      'execution_failed','readback_failed')
  ),
  failure_code text,
  failure_detail jsonb,
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  execution_started_at timestamptz,
  committed_at timestamptz,
  readback_finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT mutation_commands_public_unique UNIQUE (command_id),
  CONSTRAINT mutation_commands_household_public_unique UNIQUE (household_id, command_id),
  CONSTRAINT mutation_commands_household_internal_unique UNIQUE (household_id, id),
  CONSTRAINT mutation_commands_idempotency_unique UNIQUE (household_id, idempotency_key),
  CONSTRAINT mutation_commands_checked_proposal_once UNIQUE
    (household_id, checked_proposal_id, checked_proposal_hash),
  CONSTRAINT mutation_commands_task_fk FOREIGN KEY (household_id, task_id)
    REFERENCES operations.verification_tasks(household_id, task_id),
  CONSTRAINT mutation_commands_artifact_fk
    FOREIGN KEY (household_id, task_id, checked_proposal_id, checked_proposal_hash)
    REFERENCES operations.artifacts(household_id, task_id, artifact_id, artifact_hash),
  CONSTRAINT mutation_commands_confirmation_fk FOREIGN KEY (household_id, confirmation_id)
    REFERENCES operations.external_confirmations(household_id, id),
  CONSTRAINT mutation_commands_confirmation_shape CHECK (
    (confirmation_required AND confirmation_id IS NOT NULL)
    OR (NOT confirmation_required)
  )
);

CREATE TABLE operations.mutation_receipts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_id text NOT NULL CONSTRAINT mutation_receipts_public_id_format
    CHECK (receipt_id ~ '^receipt_[0-9A-HJKMNP-TV-Z]{26}$'),
  household_id bigint NOT NULL,
  command_id bigint NOT NULL,
  task_id text NOT NULL,
  checked_proposal_id text NOT NULL,
  checked_proposal_hash text NOT NULL CONSTRAINT mutation_receipts_hash_format
    CHECK (checked_proposal_hash ~ '^[0-9a-f]{64}$'),
  command_type text NOT NULL,
  idempotency_key text NOT NULL,
  committed_records jsonb NOT NULL CONSTRAINT mutation_receipts_records_array
    CHECK (jsonb_typeof(committed_records) = 'array' AND jsonb_array_length(committed_records) > 0),
  expected_state jsonb NOT NULL,
  expected_state_hash text NOT NULL CONSTRAINT mutation_receipts_expected_hash_format
    CHECK (expected_state_hash ~ '^[0-9a-f]{64}$'),
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT mutation_receipts_public_unique UNIQUE (receipt_id),
  CONSTRAINT mutation_receipts_household_public_unique UNIQUE (household_id, receipt_id),
  CONSTRAINT mutation_receipts_household_internal_unique UNIQUE (household_id, id),
  CONSTRAINT mutation_receipts_command_unique UNIQUE (household_id, command_id),
  CONSTRAINT mutation_receipts_command_fk FOREIGN KEY (household_id, command_id)
    REFERENCES operations.mutation_commands(household_id, id)
);

CREATE TABLE operations.mutation_readbacks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  readback_id text NOT NULL CONSTRAINT mutation_readbacks_public_id_format
    CHECK (readback_id ~ '^readback_[0-9A-HJKMNP-TV-Z]{26}$'),
  household_id bigint NOT NULL,
  command_id bigint NOT NULL,
  receipt_id bigint NOT NULL,
  ok boolean NOT NULL,
  checks jsonb NOT NULL CONSTRAINT mutation_readbacks_checks_array
    CHECK (jsonb_typeof(checks) = 'array' AND jsonb_array_length(checks) > 0),
  mismatches text[] NOT NULL DEFAULT '{}',
  observed_state_hash text NOT NULL CONSTRAINT mutation_readbacks_observed_hash_format
    CHECK (observed_state_hash ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT mutation_readbacks_public_unique UNIQUE (readback_id),
  CONSTRAINT mutation_readbacks_household_public_unique UNIQUE (household_id, readback_id),
  CONSTRAINT mutation_readbacks_command_unique UNIQUE (household_id, command_id),
  CONSTRAINT mutation_readbacks_command_fk FOREIGN KEY (household_id, command_id)
    REFERENCES operations.mutation_commands(household_id, id),
  CONSTRAINT mutation_readbacks_receipt_fk FOREIGN KEY (household_id, receipt_id)
    REFERENCES operations.mutation_receipts(household_id, id),
  CONSTRAINT mutation_readbacks_consistency CHECK (
    (ok AND cardinality(mismatches) = 0)
    OR (NOT ok AND cardinality(mismatches) > 0)
  )
);

CREATE FUNCTION operations.validate_mutation_command_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, operations
AS $$
DECLARE
  artifact operations.artifacts%ROWTYPE;
  confirmation operations.external_confirmations%ROWTYPE;
  accepted boolean;
BEGIN
  SELECT * INTO artifact
  FROM operations.artifacts
  WHERE household_id = NEW.household_id
    AND task_id = NEW.task_id
    AND artifact_id = NEW.checked_proposal_id
    AND artifact_hash = NEW.checked_proposal_hash;

  SELECT EXISTS (
    SELECT 1
    FROM operations.checker_verdicts verdict
    WHERE verdict.household_id = NEW.household_id
      AND verdict.task_id = NEW.task_id
      AND verdict.covered_artifact_id = NEW.checked_proposal_id
      AND verdict.covered_artifact_hash = NEW.checked_proposal_hash
      AND verdict.verdict = 'accepted'
  ) INTO accepted;

  IF artifact.id IS NULL
    OR artifact.payload->'output' <> NEW.payload
    OR artifact.payload #>> '{outputSchema,schemaName}' <> NEW.payload_schema_name
    OR (artifact.payload #>> '{outputSchema,schemaVersion}')::integer <> NEW.payload_schema_version
    OR NOT accepted THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'mutation_command_exact_artifact',
      MESSAGE = 'Mutation command does not match an accepted maker artifact';
  END IF;

  IF NEW.confirmation_required OR NEW.confirmation_id IS NOT NULL THEN
    SELECT * INTO confirmation
    FROM operations.external_confirmations
    WHERE household_id = NEW.household_id
      AND id = NEW.confirmation_id;

    IF confirmation.id IS NULL
      OR confirmation.task_id <> NEW.task_id
      OR confirmation.checked_proposal_id <> NEW.checked_proposal_id
      OR confirmation.checked_proposal_hash <> NEW.checked_proposal_hash THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'mutation_command_exact_confirmation',
        MESSAGE = 'Mutation confirmation does not match the checked artifact';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION operations.guard_mutation_command_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, operations
AS $$
BEGIN
  IF OLD.command_id <> NEW.command_id
    OR OLD.household_id <> NEW.household_id
    OR OLD.task_id <> NEW.task_id
    OR OLD.command_type <> NEW.command_type
    OR OLD.checked_proposal_id <> NEW.checked_proposal_id
    OR OLD.checked_proposal_hash <> NEW.checked_proposal_hash
    OR OLD.idempotency_key <> NEW.idempotency_key
    OR OLD.confirmation_required <> NEW.confirmation_required
    OR OLD.confirmation_id IS DISTINCT FROM NEW.confirmation_id
    OR OLD.payload_schema_name <> NEW.payload_schema_name
    OR OLD.payload_schema_version <> NEW.payload_schema_version
    OR OLD.payload <> NEW.payload
    OR OLD.registered_at <> NEW.registered_at THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'operations.mutation_commands identity is immutable';
  END IF;

  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'registered' AND NEW.status IN ('execution_pending','execution_failed'))
    OR (OLD.status = 'execution_pending' AND NEW.status IN ('committed','execution_failed'))
    OR (OLD.status = 'committed' AND NEW.status IN ('readback_verified','readback_failed'))
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'mutation_command_status_transition',
      MESSAGE = 'Illegal mutation command status transition';
  END IF;

  IF NEW.status = 'committed' AND NOT EXISTS (
    SELECT 1 FROM operations.mutation_receipts receipt
    WHERE receipt.household_id = NEW.household_id
      AND receipt.command_id = NEW.id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'mutation_command_receipt_required',
      MESSAGE = 'Committed mutation commands require a receipt';
  END IF;

  IF NEW.status IN ('readback_verified','readback_failed') AND NOT EXISTS (
    SELECT 1 FROM operations.mutation_readbacks readback
    WHERE readback.household_id = NEW.household_id
      AND readback.command_id = NEW.id
      AND readback.ok = (NEW.status = 'readback_verified')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'mutation_command_readback_required',
      MESSAGE = 'Read-back terminal command states require read-back evidence';
  END IF;

  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER external_confirmations_immutable
BEFORE UPDATE OR DELETE ON operations.external_confirmations
FOR EACH ROW EXECUTE FUNCTION operations.reject_immutable_change();

CREATE TRIGGER mutation_receipts_immutable
BEFORE UPDATE OR DELETE ON operations.mutation_receipts
FOR EACH ROW EXECUTE FUNCTION operations.reject_immutable_change();

CREATE TRIGGER mutation_readbacks_immutable
BEFORE UPDATE OR DELETE ON operations.mutation_readbacks
FOR EACH ROW EXECUTE FUNCTION operations.reject_immutable_change();

CREATE TRIGGER mutation_commands_validate_exact
BEFORE INSERT ON operations.mutation_commands
FOR EACH ROW EXECUTE FUNCTION operations.validate_mutation_command_insert();

CREATE TRIGGER mutation_commands_guard_update
BEFORE UPDATE ON operations.mutation_commands
FOR EACH ROW EXECUTE FUNCTION operations.guard_mutation_command_update();

CREATE TRIGGER mutation_commands_no_delete
BEFORE DELETE ON operations.mutation_commands
FOR EACH ROW EXECUTE FUNCTION operations.reject_immutable_change();

CREATE FUNCTION operations.claim_mutation_command(
  household_public_id text,
  command_public_id text
)
RETURNS TABLE(command_status text, receipt_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, operations
AS $$
BEGIN
  RETURN QUERY
  SELECT command.status, receipt.receipt_id
  FROM operations.mutation_commands command
  JOIN operations.households household ON household.id = command.household_id
  LEFT JOIN operations.mutation_receipts receipt
    ON receipt.household_id = command.household_id AND receipt.command_id = command.id
  WHERE household.household_id = household_public_id
    AND command.command_id = command_public_id
    AND command.status IN ('execution_pending','committed','readback_verified')
  FOR UPDATE OF command;
END;
$$;

CREATE FUNCTION operations.commit_mutation_command(
  household_public_id text,
  command_public_id text,
  receipt_public_id text,
  committed_records jsonb,
  expected_state jsonb,
  expected_state_hash text
)
RETURNS TABLE(receipt_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, operations
AS $$
DECLARE
  command operations.mutation_commands%ROWTYPE;
BEGIN
  SELECT candidate.* INTO command
  FROM operations.mutation_commands candidate
  JOIN operations.households household ON household.id = candidate.household_id
  WHERE household.household_id = household_public_id
    AND candidate.command_id = command_public_id
    AND candidate.status = 'execution_pending'
  FOR UPDATE OF candidate;

  IF command.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'mutation_command_claim_required',
      MESSAGE = 'Mutation command is not execution pending';
  END IF;

  INSERT INTO operations.mutation_receipts
    (receipt_id, household_id, command_id, task_id, checked_proposal_id, checked_proposal_hash,
     command_type, idempotency_key, committed_records, expected_state, expected_state_hash)
  VALUES
    (receipt_public_id, command.household_id, command.id, command.task_id,
     command.checked_proposal_id, command.checked_proposal_hash, command.command_type,
     command.idempotency_key, committed_records, expected_state, expected_state_hash);

  UPDATE operations.mutation_commands
  SET status = 'committed', committed_at = clock_timestamp()
  WHERE household_id = command.household_id AND id = command.id;

  RETURN QUERY SELECT receipt_public_id;
END;
$$;

CREATE INDEX mutation_commands_status_updated
  ON operations.mutation_commands(status, updated_at)
  WHERE status IN ('registered','execution_pending','committed');
CREATE INDEX mutation_commands_task_lookup
  ON operations.mutation_commands(household_id, task_id, registered_at DESC);
CREATE INDEX mutation_receipts_task_lookup
  ON operations.mutation_receipts(household_id, task_id, committed_at DESC);
CREATE INDEX mutation_readbacks_command_lookup
  ON operations.mutation_readbacks(household_id, command_id);

ALTER TABLE operations.external_confirmations OWNER TO plus_one_owner;
ALTER TABLE operations.mutation_commands OWNER TO plus_one_owner;
ALTER TABLE operations.mutation_receipts OWNER TO plus_one_owner;
ALTER TABLE operations.mutation_readbacks OWNER TO plus_one_owner;
ALTER FUNCTION operations.validate_mutation_command_insert() OWNER TO plus_one_owner;
ALTER FUNCTION operations.guard_mutation_command_update() OWNER TO plus_one_owner;
ALTER FUNCTION operations.claim_mutation_command(text,text) OWNER TO plus_one_owner;
ALTER FUNCTION operations.commit_mutation_command(text,text,text,jsonb,jsonb,text) OWNER TO plus_one_owner;

REVOKE ALL ON operations.external_confirmations, operations.mutation_commands,
  operations.mutation_receipts, operations.mutation_readbacks FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.claim_mutation_command(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.commit_mutation_command(text,text,text,jsonb,jsonb,text) FROM PUBLIC;

GRANT SELECT, INSERT ON operations.external_confirmations, operations.mutation_commands
  TO plus_one_operations;
GRANT UPDATE (status, failure_code, failure_detail, execution_started_at, committed_at,
  readback_finished_at, updated_at) ON operations.mutation_commands TO plus_one_operations;
GRANT SELECT ON operations.mutation_receipts, operations.mutation_readbacks TO plus_one_operations;
GRANT INSERT ON operations.mutation_readbacks TO plus_one_operations;
GRANT USAGE, SELECT ON SEQUENCE operations.external_confirmations_id_seq,
  operations.mutation_commands_id_seq, operations.mutation_readbacks_id_seq
  TO plus_one_operations;

GRANT EXECUTE ON FUNCTION operations.claim_mutation_command(text,text) TO plus_one_accounting;
GRANT EXECUTE ON FUNCTION operations.commit_mutation_command(text,text,text,jsonb,jsonb,text)
  TO plus_one_accounting;

RESET ROLE;
