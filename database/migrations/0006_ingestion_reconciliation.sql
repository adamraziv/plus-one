SET ROLE plus_one_owner;
BEGIN;
SET LOCAL search_path = pg_catalog, ingestion, accounting, operations;

CREATE TABLE ingestion.source_documents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_document_id text NOT NULL CONSTRAINT source_documents_public_id_format
    CHECK (source_document_id ~ '^source_[0-9A-HJKMNP-TV-Z]{26}$'),
  household_id bigint NOT NULL REFERENCES operations.households(id),
  source_account_id bigint NOT NULL,
  source_system text NOT NULL CONSTRAINT source_documents_source_system_nonempty CHECK (btrim(source_system) <> ''),
  content_hash text NOT NULL CONSTRAINT source_documents_content_hash_format CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  byte_size bigint NOT NULL CONSTRAINT source_documents_byte_size_nonnegative CHECK (byte_size >= 0),
  storage_key text NOT NULL CONSTRAINT source_documents_storage_key_nonempty CHECK (btrim(storage_key) <> ''),
  media_type text NOT NULL CONSTRAINT source_documents_media_type CHECK (media_type IN ('text/csv','application/json')),
  parser_version text NOT NULL CONSTRAINT source_documents_parser_nonempty CHECK (btrim(parser_version) <> ''),
  source_schema_version text NOT NULL CONSTRAINT source_documents_schema_nonempty CHECK (btrim(source_schema_version) <> ''),
  extraction_status text NOT NULL CONSTRAINT source_documents_extraction_status CHECK (extraction_status IN ('received','extracted','failed')),
  upload_reference text NOT NULL CONSTRAINT source_documents_upload_reference_nonempty CHECK (btrim(upload_reference) <> ''),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT source_documents_public_id_unique UNIQUE (source_document_id),
  CONSTRAINT source_documents_household_internal_unique UNIQUE (household_id, id),
  CONSTRAINT source_documents_scope_hash_unique UNIQUE (household_id, source_account_id, source_system, content_hash),
  CONSTRAINT source_documents_storage_key_unique UNIQUE (storage_key),
  CONSTRAINT source_documents_account_fk FOREIGN KEY (household_id, source_account_id)
    REFERENCES accounting.accounts(household_id, id)
);

CREATE TABLE ingestion.import_batches (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_batch_id text NOT NULL CONSTRAINT import_batches_public_id_format
    CHECK (import_batch_id ~ '^import_[0-9A-HJKMNP-TV-Z]{26}$'),
  household_id bigint NOT NULL,
  source_document_id bigint NOT NULL,
  batch_version integer NOT NULL DEFAULT 1 CONSTRAINT import_batches_version_positive CHECK (batch_version > 0),
  state text NOT NULL CONSTRAINT import_batches_state CHECK (state IN (
    'received','extracted','normalized','checked','awaiting_confirmation',
    'approved','rejected','posting','posted','partially_posted','failed'
  )),
  checked_artifact_id bigint,
  checked_artifact_hash text CONSTRAINT import_batches_checked_hash_format
    CHECK (checked_artifact_hash IS NULL OR checked_artifact_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT import_batches_public_id_unique UNIQUE (import_batch_id),
  CONSTRAINT import_batches_household_internal_unique UNIQUE (household_id, id),
  CONSTRAINT import_batches_source_version_unique UNIQUE (source_document_id, batch_version),
  CONSTRAINT import_batches_source_fk FOREIGN KEY (household_id, source_document_id)
    REFERENCES ingestion.source_documents(household_id, id),
  CONSTRAINT import_batches_artifact_fk FOREIGN KEY (checked_artifact_id)
    REFERENCES operations.artifacts(id)
);

CREATE TABLE ingestion.raw_rows (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  raw_row_id text NOT NULL CONSTRAINT raw_rows_public_id_format
    CHECK (raw_row_id ~ '^rawrow_[0-9A-HJKMNP-TV-Z]{26}$'),
  import_batch_id bigint NOT NULL,
  source_row_identity text NOT NULL CONSTRAINT raw_rows_identity_nonempty CHECK (btrim(source_row_identity) <> ''),
  source_row_number integer CONSTRAINT raw_rows_number_positive CHECK (source_row_number > 0),
  raw_payload jsonb NOT NULL,
  canonical_raw_hash text NOT NULL CONSTRAINT raw_rows_hash_format CHECK (canonical_raw_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT raw_rows_public_id_unique UNIQUE (raw_row_id),
  CONSTRAINT raw_rows_batch_identity_unique UNIQUE (import_batch_id, source_row_identity),
  CONSTRAINT raw_rows_batch_hash_unique UNIQUE (import_batch_id, canonical_raw_hash, source_row_identity),
  CONSTRAINT raw_rows_batch_fk FOREIGN KEY (import_batch_id) REFERENCES ingestion.import_batches(id)
);

CREATE TABLE ingestion.normalized_rows (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  normalized_row_id text NOT NULL CONSTRAINT normalized_rows_public_id_format
    CHECK (normalized_row_id ~ '^normrow_[0-9A-HJKMNP-TV-Z]{26}$'),
  raw_row_id bigint NOT NULL REFERENCES ingestion.raw_rows(id),
  version integer NOT NULL CONSTRAINT normalized_rows_version_positive CHECK (version > 0),
  occurred_on date NOT NULL,
  posted_on date,
  amount operations.decimal_amount NOT NULL,
  currency operations.currency_code NOT NULL REFERENCES operations.currency_metadata(currency_code),
  description text NOT NULL CONSTRAINT normalized_rows_description_nonempty CHECK (btrim(description) <> ''),
  counterparty text,
  external_transaction_id text,
  parser_version text NOT NULL,
  normalized_payload jsonb NOT NULL,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb CONSTRAINT normalized_rows_warnings_array CHECK (jsonb_typeof(warnings) = 'array'),
  exact_fingerprint text NOT NULL CONSTRAINT normalized_rows_fingerprint_format CHECK (exact_fingerprint ~ '^[0-9a-f]{64}$'),
  fingerprint_kind text NOT NULL CONSTRAINT normalized_rows_fingerprint_kind CHECK (fingerprint_kind IN ('stable_external_id','source_row_fallback')),
  row_state text NOT NULL CONSTRAINT normalized_rows_state CHECK (row_state IN (
    'normalized','exact_duplicate','probable_duplicate','ready','awaiting_confirmation',
    'approved','linked_existing','deferred','rejected','posted','failed'
  )),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT normalized_rows_public_id_unique UNIQUE (normalized_row_id),
  CONSTRAINT normalized_rows_raw_version_unique UNIQUE (raw_row_id, version),
  CONSTRAINT normalized_rows_exact_replay_unique UNIQUE (exact_fingerprint)
);

CREATE TABLE ingestion.match_decisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  match_decision_id text NOT NULL CONSTRAINT match_decisions_public_id_format
    CHECK (match_decision_id ~ '^match_[0-9A-HJKMNP-TV-Z]{26}$'),
  normalized_row_id bigint NOT NULL REFERENCES ingestion.normalized_rows(id),
  candidate_journal_id bigint REFERENCES accounting.journals(id),
  decision text NOT NULL CONSTRAINT match_decisions_decision CHECK (decision IN (
    'exact_duplicate','probable_duplicate','new_transaction','link_existing','defer','reject'
  )),
  score numeric(5,4) NOT NULL CONSTRAINT match_decisions_score_range CHECK (score BETWEEN 0 AND 1),
  evidence jsonb NOT NULL,
  maker_artifact_id bigint REFERENCES operations.artifacts(id),
  checker_artifact_id bigint REFERENCES operations.artifacts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT match_decisions_public_id_unique UNIQUE (match_decision_id)
);

CREATE TABLE ingestion.import_row_decisions (
  import_batch_id bigint NOT NULL REFERENCES ingestion.import_batches(id),
  normalized_row_id bigint NOT NULL REFERENCES ingestion.normalized_rows(id),
  checked_artifact_id bigint NOT NULL REFERENCES operations.artifacts(id),
  checked_artifact_hash text NOT NULL CONSTRAINT import_row_decisions_hash_format CHECK (checked_artifact_hash ~ '^[0-9a-f]{64}$'),
  action text NOT NULL CONSTRAINT import_row_decisions_action CHECK (action IN ('post','link_existing','defer','reject')),
  target_journal_id bigint REFERENCES accounting.journals(id),
  reason_code text NOT NULL CONSTRAINT import_row_decisions_reason_nonempty CHECK (btrim(reason_code) <> ''),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (import_batch_id, normalized_row_id)
);

CREATE TABLE ingestion.statement_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  statement_snapshot_id text NOT NULL CONSTRAINT statement_snapshots_public_id_format
    CHECK (statement_snapshot_id ~ '^snapshot_[0-9A-HJKMNP-TV-Z]{26}$'),
  household_id bigint NOT NULL,
  source_document_id bigint NOT NULL,
  account_id bigint NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  currency operations.currency_code NOT NULL REFERENCES operations.currency_metadata(currency_code),
  opening_balance operations.decimal_amount NOT NULL,
  closing_balance operations.decimal_amount NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT statement_snapshots_public_id_unique UNIQUE (statement_snapshot_id),
  CONSTRAINT statement_snapshots_period_order CHECK (period_start <= period_end),
  CONSTRAINT statement_snapshots_scope_unique UNIQUE (source_document_id, account_id, period_start, period_end),
  CONSTRAINT statement_snapshots_source_fk FOREIGN KEY (household_id, source_document_id)
    REFERENCES ingestion.source_documents(household_id, id),
  CONSTRAINT statement_snapshots_account_fk FOREIGN KEY (household_id, account_id)
    REFERENCES accounting.accounts(household_id, id)
);

CREATE TABLE ingestion.statement_lines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  statement_line_id text NOT NULL CONSTRAINT statement_lines_public_id_format
    CHECK (statement_line_id ~ '^stmtline_[0-9A-HJKMNP-TV-Z]{26}$'),
  statement_snapshot_id bigint NOT NULL REFERENCES ingestion.statement_snapshots(id),
  normalized_row_id bigint REFERENCES ingestion.normalized_rows(id),
  source_line_identity text NOT NULL CONSTRAINT statement_lines_identity_nonempty CHECK (btrim(source_line_identity) <> ''),
  occurred_on date NOT NULL,
  amount operations.decimal_amount NOT NULL,
  description text NOT NULL CONSTRAINT statement_lines_description_nonempty CHECK (btrim(description) <> ''),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT statement_lines_public_id_unique UNIQUE (statement_line_id),
  CONSTRAINT statement_lines_snapshot_identity_unique UNIQUE (statement_snapshot_id, source_line_identity)
);

CREATE TABLE accounting.journal_source_links (
  journal_id bigint NOT NULL REFERENCES accounting.journals(id),
  normalized_row_id bigint NOT NULL REFERENCES ingestion.normalized_rows(id),
  link_kind text NOT NULL CONSTRAINT journal_source_links_kind CHECK (link_kind IN ('import_posted','matched_existing','reconciled')),
  checked_artifact_id bigint NOT NULL REFERENCES operations.artifacts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (journal_id, normalized_row_id, link_kind)
);

CREATE TABLE accounting.reconciliations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reconciliation_id text NOT NULL CONSTRAINT reconciliations_public_id_format
    CHECK (reconciliation_id ~ '^recon_[0-9A-HJKMNP-TV-Z]{26}$'),
  household_id bigint NOT NULL REFERENCES operations.households(id),
  book_id bigint NOT NULL,
  account_id bigint NOT NULL,
  statement_snapshot_id bigint NOT NULL REFERENCES ingestion.statement_snapshots(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  currency operations.currency_code NOT NULL REFERENCES operations.currency_metadata(currency_code),
  ledger_opening_balance operations.decimal_amount NOT NULL,
  ledger_closing_balance operations.decimal_amount NOT NULL,
  statement_opening_balance operations.decimal_amount NOT NULL,
  statement_closing_balance operations.decimal_amount NOT NULL,
  completion_status text NOT NULL CONSTRAINT reconciliations_completion_status CHECK (completion_status IN ('reconciled','reconciled_with_exceptions','incomplete')),
  unresolved_discrepancies jsonb NOT NULL,
  maker_artifact_id bigint NOT NULL REFERENCES operations.artifacts(id),
  checker_artifact_id bigint NOT NULL REFERENCES operations.artifacts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT reconciliations_public_id_unique UNIQUE (reconciliation_id),
  CONSTRAINT reconciliations_statement_maker_unique UNIQUE (statement_snapshot_id, maker_artifact_id),
  CONSTRAINT reconciliations_book_fk FOREIGN KEY (household_id, book_id)
    REFERENCES accounting.books(household_id, id),
  CONSTRAINT reconciliations_account_fk FOREIGN KEY (household_id, account_id)
    REFERENCES accounting.accounts(household_id, id)
);

CREATE TABLE accounting.reconciliation_evidence (
  reconciliation_id bigint NOT NULL REFERENCES accounting.reconciliations(id),
  artifact_id bigint NOT NULL REFERENCES operations.artifacts(id),
  PRIMARY KEY (reconciliation_id, artifact_id)
);

CREATE TABLE accounting.reconciliation_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reconciliation_item_id text NOT NULL CONSTRAINT reconciliation_items_public_id_format
    CHECK (reconciliation_item_id ~ '^reconitem_[0-9A-HJKMNP-TV-Z]{26}$'),
  reconciliation_id bigint NOT NULL REFERENCES accounting.reconciliations(id),
  statement_line_id bigint REFERENCES ingestion.statement_lines(id),
  normalized_row_id bigint REFERENCES ingestion.normalized_rows(id),
  journal_id bigint REFERENCES accounting.journals(id),
  status text NOT NULL CONSTRAINT reconciliation_items_status CHECK (status IN ('matched','unmatched','duplicate','disputed','timing_difference')),
  amount_difference operations.decimal_amount NOT NULL,
  explanation text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT reconciliation_items_public_id_unique UNIQUE (reconciliation_item_id)
);

CREATE TABLE accounting.period_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  period_event_id text NOT NULL CONSTRAINT period_events_public_id_format
    CHECK (period_event_id ~ '^periodevent_[0-9A-HJKMNP-TV-Z]{26}$'),
  household_id bigint NOT NULL REFERENCES operations.households(id),
  book_id bigint NOT NULL,
  period_id bigint NOT NULL,
  event_type text NOT NULL CONSTRAINT period_events_type CHECK (event_type IN ('closed','reopened')),
  prior_event_id bigint REFERENCES accounting.period_events(id),
  reconciliation_ids jsonb NOT NULL CONSTRAINT period_events_reconciliation_ids_array CHECK (jsonb_typeof(reconciliation_ids) = 'array'),
  unresolved_discrepancy_ids jsonb NOT NULL CONSTRAINT period_events_discrepancy_ids_array CHECK (jsonb_typeof(unresolved_discrepancy_ids) = 'array'),
  responsible_artifact_ids jsonb NOT NULL CONSTRAINT period_events_artifact_ids_array CHECK (jsonb_typeof(responsible_artifact_ids) = 'array'),
  checked_artifact_id bigint NOT NULL REFERENCES operations.artifacts(id),
  confirmation_id bigint REFERENCES operations.external_confirmations(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT period_events_public_id_unique UNIQUE (period_event_id),
  CONSTRAINT period_events_period_fk FOREIGN KEY (household_id, book_id, period_id)
    REFERENCES accounting.periods(household_id, book_id, id)
);

CREATE FUNCTION ingestion.reject_immutable_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', CONSTRAINT = 'ingestion_immutable_fact',
    MESSAGE = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || ' is immutable';
END;
$$;

CREATE FUNCTION ingestion.guard_import_batch_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.household_id <> OLD.household_id OR NEW.source_document_id <> OLD.source_document_id
     OR NEW.batch_version <> OLD.batch_version OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '55000', CONSTRAINT = 'import_batch_identity_immutable';
  END IF;
  IF (OLD.state, NEW.state) NOT IN (
    ('received','extracted'), ('received','failed'), ('extracted','normalized'), ('extracted','failed'),
    ('normalized','checked'), ('normalized','failed'), ('checked','awaiting_confirmation'),
    ('awaiting_confirmation','approved'), ('awaiting_confirmation','rejected'),
    ('approved','posting'), ('posting','posted'), ('posting','partially_posted'), ('posting','failed')
  ) AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION USING ERRCODE = '55000', CONSTRAINT = 'import_batch_transition_invalid';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER source_documents_immutable BEFORE UPDATE OR DELETE ON ingestion.source_documents
FOR EACH ROW EXECUTE FUNCTION ingestion.reject_immutable_change();
CREATE TRIGGER raw_rows_immutable BEFORE UPDATE OR DELETE ON ingestion.raw_rows
FOR EACH ROW EXECUTE FUNCTION ingestion.reject_immutable_change();
CREATE TRIGGER statement_snapshots_immutable BEFORE UPDATE OR DELETE ON ingestion.statement_snapshots
FOR EACH ROW EXECUTE FUNCTION ingestion.reject_immutable_change();
CREATE TRIGGER statement_lines_immutable BEFORE UPDATE OR DELETE ON ingestion.statement_lines
FOR EACH ROW EXECUTE FUNCTION ingestion.reject_immutable_change();
CREATE TRIGGER reconciliations_immutable BEFORE UPDATE OR DELETE ON accounting.reconciliations
FOR EACH ROW EXECUTE FUNCTION ingestion.reject_immutable_change();
CREATE TRIGGER period_events_immutable BEFORE UPDATE OR DELETE ON accounting.period_events
FOR EACH ROW EXECUTE FUNCTION ingestion.reject_immutable_change();
CREATE TRIGGER import_batch_transition BEFORE UPDATE ON ingestion.import_batches
FOR EACH ROW EXECUTE FUNCTION ingestion.guard_import_batch_transition();

CREATE INDEX source_documents_scope_lookup ON ingestion.source_documents(household_id, source_account_id, source_system);
CREATE INDEX import_batches_source_lookup ON ingestion.import_batches(source_document_id, state);
CREATE INDEX raw_rows_batch_idx ON ingestion.raw_rows(import_batch_id, source_row_number);
CREATE INDEX normalized_rows_external_lookup_idx ON ingestion.normalized_rows(external_transaction_id) WHERE external_transaction_id IS NOT NULL;
CREATE INDEX statement_snapshots_account_period_idx ON ingestion.statement_snapshots(household_id, account_id, period_start, period_end);
CREATE INDEX reconciliations_account_period_idx ON accounting.reconciliations(household_id, account_id, period_start, period_end);

ALTER TABLE ingestion.source_documents OWNER TO plus_one_owner;
ALTER TABLE ingestion.import_batches OWNER TO plus_one_owner;
ALTER TABLE ingestion.raw_rows OWNER TO plus_one_owner;
ALTER TABLE ingestion.normalized_rows OWNER TO plus_one_owner;
ALTER TABLE ingestion.match_decisions OWNER TO plus_one_owner;
ALTER TABLE ingestion.import_row_decisions OWNER TO plus_one_owner;
ALTER TABLE ingestion.statement_snapshots OWNER TO plus_one_owner;
ALTER TABLE ingestion.statement_lines OWNER TO plus_one_owner;
ALTER TABLE accounting.journal_source_links OWNER TO plus_one_owner;
ALTER TABLE accounting.reconciliations OWNER TO plus_one_owner;
ALTER TABLE accounting.reconciliation_evidence OWNER TO plus_one_owner;
ALTER TABLE accounting.reconciliation_items OWNER TO plus_one_owner;
ALTER TABLE accounting.period_events OWNER TO plus_one_owner;
ALTER FUNCTION ingestion.reject_immutable_change() OWNER TO plus_one_owner;
ALTER FUNCTION ingestion.guard_import_batch_transition() OWNER TO plus_one_owner;

REVOKE ALL ON ALL TABLES IN SCHEMA ingestion FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA ingestion FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ingestion FROM PUBLIC;

GRANT SELECT, INSERT ON
  ingestion.source_documents, ingestion.raw_rows, ingestion.normalized_rows,
  ingestion.match_decisions, ingestion.import_row_decisions,
  ingestion.statement_snapshots, ingestion.statement_lines,
  accounting.journal_source_links, accounting.reconciliations,
  accounting.reconciliation_evidence, accounting.reconciliation_items,
  accounting.period_events
TO plus_one_accounting;
GRANT SELECT, INSERT, UPDATE (state, checked_artifact_id, checked_artifact_hash, updated_at)
  ON ingestion.import_batches TO plus_one_accounting;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ingestion TO plus_one_accounting;

REVOKE ALL ON ALL TABLES IN SCHEMA ingestion FROM plus_one_query, plus_one_planning, plus_one_operations, plus_one_memory;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA ingestion FROM plus_one_query, plus_one_planning, plus_one_operations, plus_one_memory;
REVOKE DELETE, TRUNCATE ON accounting.period_events FROM plus_one_accounting;

ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner IN SCHEMA ingestion
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner IN SCHEMA ingestion
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner IN SCHEMA ingestion
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMIT;
RESET ROLE;
