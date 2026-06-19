SET ROLE plus_one_owner;
BEGIN;
SET LOCAL search_path = pg_catalog, ingestion, accounting, operations;

ALTER TABLE ingestion.normalized_rows
  ADD COLUMN household_id bigint,
  ADD COLUMN source_account_id bigint,
  ADD COLUMN source_system text;

UPDATE ingestion.normalized_rows normalized
SET household_id = source.household_id,
    source_account_id = source.source_account_id,
    source_system = source.source_system
FROM ingestion.raw_rows raw
JOIN ingestion.import_batches batch ON batch.id = raw.import_batch_id
JOIN ingestion.source_documents source ON source.id = batch.source_document_id
WHERE normalized.raw_row_id = raw.id;

ALTER TABLE ingestion.normalized_rows
  ALTER COLUMN household_id SET NOT NULL,
  ALTER COLUMN source_account_id SET NOT NULL,
  ALTER COLUMN source_system SET NOT NULL,
  ADD CONSTRAINT normalized_rows_source_system_nonempty CHECK (btrim(source_system) <> ''),
  ADD CONSTRAINT normalized_rows_source_account_fk FOREIGN KEY (household_id, source_account_id)
    REFERENCES accounting.accounts(household_id, id);

CREATE FUNCTION ingestion.populate_normalized_row_source_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  SELECT source.household_id, source.source_account_id, source.source_system
    INTO NEW.household_id, NEW.source_account_id, NEW.source_system
  FROM ingestion.raw_rows raw
  JOIN ingestion.import_batches batch ON batch.id = raw.import_batch_id
  JOIN ingestion.source_documents source ON source.id = batch.source_document_id
  WHERE raw.id = NEW.raw_row_id;

  IF NEW.household_id IS NULL OR NEW.source_account_id IS NULL OR NEW.source_system IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23503', CONSTRAINT = 'normalized_rows_source_scope_required',
      MESSAGE = 'normalized row source scope is required';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER normalized_rows_source_scope
BEFORE INSERT OR UPDATE OF raw_row_id ON ingestion.normalized_rows
FOR EACH ROW EXECUTE FUNCTION ingestion.populate_normalized_row_source_scope();

ALTER TABLE ingestion.normalized_rows
  DROP CONSTRAINT normalized_rows_exact_replay_unique,
  ADD CONSTRAINT normalized_rows_source_scope_exact_replay_unique
    UNIQUE (household_id, source_account_id, source_system, exact_fingerprint);

ALTER FUNCTION ingestion.populate_normalized_row_source_scope() OWNER TO plus_one_owner;

COMMIT;
RESET ROLE;
