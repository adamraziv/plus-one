SET ROLE plus_one_owner;

CREATE OR REPLACE FUNCTION operations.validate_mutation_command_insert()
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
    OR artifact.payload->'output' IS DISTINCT FROM NEW.payload
    OR artifact.payload #> '{output,schemaName}' IS DISTINCT FROM to_jsonb(NEW.payload_schema_name)
    OR artifact.payload #> '{output,schemaVersion}' IS DISTINCT FROM to_jsonb(NEW.payload_schema_version) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'mutation_command_exact_artifact',
      MESSAGE = 'Mutation command does not match the exact maker artifact';
  END IF;

  IF NOT accepted THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'mutation_command_acceptance_required',
      MESSAGE = 'Mutation command does not have an accepting checker verdict';
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

RESET ROLE;
