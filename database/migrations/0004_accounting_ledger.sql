SET ROLE plus_one_owner;
BEGIN;
SET LOCAL search_path = pg_catalog, accounting, operations;

CREATE TABLE accounting.books (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  book_id text NOT NULL CONSTRAINT books_public_id_format
    CHECK (book_id ~ '^book_[0-9A-HJKMNP-TV-Z]{26}$'),
  household_id bigint NOT NULL REFERENCES operations.households(id),
  name text NOT NULL CONSTRAINT books_name_nonempty CHECK (btrim(name) <> ''),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT books_public_id_unique UNIQUE (book_id),
  CONSTRAINT books_one_per_household UNIQUE (household_id),
  CONSTRAINT books_household_internal_unique UNIQUE (household_id, id),
  CONSTRAINT books_household_public_unique UNIQUE (household_id, book_id)
);

CREATE TABLE accounting.book_configurations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  configuration_id text NOT NULL CONSTRAINT book_configurations_public_id_format
    CHECK (configuration_id ~ '^bookconfig_[0-9A-HJKMNP-TV-Z]{26}$'),
  household_id bigint NOT NULL,
  book_id bigint NOT NULL,
  reporting_currency operations.currency_code NOT NULL
    REFERENCES operations.currency_metadata(currency_code),
  effective_from date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT book_configurations_public_id_unique UNIQUE (configuration_id),
  CONSTRAINT book_configurations_effective_unique UNIQUE (household_id, book_id, effective_from),
  CONSTRAINT book_configurations_book_fk FOREIGN KEY (household_id, book_id)
    REFERENCES accounting.books(household_id, id)
);

CREATE TABLE accounting.accounts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL CONSTRAINT accounts_public_id_format
    CHECK (account_id ~ '^account_[0-9A-HJKMNP-TV-Z]{26}$'),
  household_id bigint NOT NULL,
  book_id bigint NOT NULL,
  parent_account_id bigint,
  name text NOT NULL CONSTRAINT accounts_name_nonempty CHECK (btrim(name) <> ''),
  purpose text,
  accounting_class text NOT NULL CONSTRAINT accounts_class
    CHECK (accounting_class IN ('asset','liability','equity','income','expense')),
  normal_balance text NOT NULL CONSTRAINT accounts_normal_balance
    CHECK (normal_balance IN ('debit','credit')),
  native_currency operations.currency_code NOT NULL
    REFERENCES operations.currency_metadata(currency_code),
  ownership_label text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT accounts_public_id_unique UNIQUE (account_id),
  CONSTRAINT accounts_household_public_unique UNIQUE (household_id, account_id),
  CONSTRAINT accounts_household_internal_unique UNIQUE (household_id, id),
  CONSTRAINT accounts_household_book_internal_unique UNIQUE (household_id, book_id, id),
  CONSTRAINT accounts_book_fk FOREIGN KEY (household_id, book_id)
    REFERENCES accounting.books(household_id, id),
  CONSTRAINT accounts_parent_fk FOREIGN KEY (household_id, book_id, parent_account_id)
    REFERENCES accounting.accounts(household_id, book_id, id),
  CONSTRAINT accounts_not_own_parent CHECK (parent_account_id IS NULL OR parent_account_id <> id)
);

CREATE TABLE accounting.account_source_mappings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mapping_id text NOT NULL CONSTRAINT account_source_mappings_public_id_format
    CHECK (mapping_id ~ '^accountmap_[0-9A-HJKMNP-TV-Z]{26}$'),
  household_id bigint NOT NULL,
  book_id bigint NOT NULL,
  account_id bigint NOT NULL,
  source_system text NOT NULL CONSTRAINT account_source_mappings_source_nonempty
    CHECK (btrim(source_system) <> ''),
  external_account_id text NOT NULL CONSTRAINT account_source_mappings_external_nonempty
    CHECK (btrim(external_account_id) <> ''),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT account_source_mappings_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT account_source_mappings_public_id_unique UNIQUE (mapping_id),
  CONSTRAINT account_source_mappings_account_fk
    FOREIGN KEY (household_id, book_id, account_id)
    REFERENCES accounting.accounts(household_id, book_id, id)
);

CREATE TABLE accounting.periods (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  period_id text NOT NULL CONSTRAINT periods_public_id_format
    CHECK (period_id ~ '^period_[0-9A-HJKMNP-TV-Z]{26}$'),
  household_id bigint NOT NULL,
  book_id bigint NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  state text NOT NULL DEFAULT 'open' CONSTRAINT periods_state CHECK (state IN ('open','closed')),
  closed_at timestamptz,
  reopened_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT periods_public_id_unique UNIQUE (period_id),
  CONSTRAINT periods_household_public_unique UNIQUE (household_id, period_id),
  CONSTRAINT periods_household_book_internal_unique UNIQUE (household_id, book_id, id),
  CONSTRAINT periods_month_unique UNIQUE (household_id, book_id, period_start),
  CONSTRAINT periods_book_fk FOREIGN KEY (household_id, book_id)
    REFERENCES accounting.books(household_id, id),
  CONSTRAINT periods_calendar_month CHECK (
    period_start = date_trunc('month', period_start::timestamp)::date
    AND period_end = (date_trunc('month', period_start::timestamp)
      + interval '1 month - 1 day')::date
  ),
  CONSTRAINT periods_state_timestamps CHECK (
    (state = 'open' AND closed_at IS NULL)
    OR (state = 'closed' AND closed_at IS NOT NULL)
  )
);

CREATE TABLE accounting.counterparties (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  counterparty_id text NOT NULL CONSTRAINT counterparties_public_id_format
    CHECK (counterparty_id ~ '^counterparty_[0-9A-HJKMNP-TV-Z]{26}$'),
  household_id bigint NOT NULL REFERENCES operations.households(id),
  display_name text NOT NULL CONSTRAINT counterparties_name_nonempty CHECK (btrim(display_name) <> ''),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT counterparties_public_id_unique UNIQUE (counterparty_id),
  CONSTRAINT counterparties_household_public_unique UNIQUE (household_id, counterparty_id),
  CONSTRAINT counterparties_household_internal_unique UNIQUE (household_id, id)
);

CREATE TABLE accounting.tags (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tag_id text NOT NULL CONSTRAINT tags_public_id_format
    CHECK (tag_id ~ '^tag_[0-9A-HJKMNP-TV-Z]{26}$'),
  household_id bigint NOT NULL REFERENCES operations.households(id),
  name text NOT NULL CONSTRAINT tags_name_nonempty CHECK (btrim(name) <> ''),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tags_public_id_unique UNIQUE (tag_id),
  CONSTRAINT tags_household_name_unique UNIQUE (household_id, name),
  CONSTRAINT tags_household_public_unique UNIQUE (household_id, tag_id),
  CONSTRAINT tags_household_internal_unique UNIQUE (household_id, id)
);

CREATE TABLE accounting.journal_drafts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  draft_id text NOT NULL CONSTRAINT journal_drafts_public_id_format
    CHECK (draft_id ~ '^draft_[0-9A-HJKMNP-TV-Z]{26}$'),
  draft_series_id text NOT NULL CONSTRAINT journal_drafts_series_id_format
    CHECK (draft_series_id ~ '^draftseries_[0-9A-HJKMNP-TV-Z]{26}$'),
  version integer NOT NULL CONSTRAINT journal_drafts_version_positive CHECK (version > 0),
  previous_draft_id bigint,
  household_id bigint NOT NULL,
  book_id bigint NOT NULL,
  task_id text NOT NULL,
  checked_artifact_id text NOT NULL,
  checked_artifact_hash text NOT NULL CONSTRAINT journal_drafts_hash_format
    CHECK (checked_artifact_hash ~ '^[0-9a-f]{64}$'),
  journal_type text NOT NULL CONSTRAINT journal_drafts_type
    CHECK (journal_type IN ('ordinary','transfer','reversal','replacement','adjustment','fx_realized')),
  transaction_currency operations.currency_code NOT NULL
    REFERENCES operations.currency_metadata(currency_code),
  occurred_on date NOT NULL,
  effective_on date NOT NULL,
  settlement_on date,
  source_on date,
  description text NOT NULL CONSTRAINT journal_drafts_description_nonempty CHECK (btrim(description) <> ''),
  counterparty_id bigint,
  tag_ids text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT journal_drafts_public_id_unique UNIQUE (draft_id),
  CONSTRAINT journal_drafts_series_version_unique UNIQUE (household_id, draft_series_id, version),
  CONSTRAINT journal_drafts_artifact_once UNIQUE
    (household_id, checked_artifact_id, checked_artifact_hash),
  CONSTRAINT journal_drafts_household_internal_unique UNIQUE (household_id, id),
  CONSTRAINT journal_drafts_exact_artifact_unique UNIQUE
    (household_id, book_id, id, task_id, checked_artifact_id, checked_artifact_hash),
  CONSTRAINT journal_drafts_book_fk FOREIGN KEY (household_id, book_id)
    REFERENCES accounting.books(household_id, id),
  CONSTRAINT journal_drafts_previous_fk FOREIGN KEY (household_id, previous_draft_id)
    REFERENCES accounting.journal_drafts(household_id, id),
  CONSTRAINT journal_drafts_counterparty_fk FOREIGN KEY (household_id, counterparty_id)
    REFERENCES accounting.counterparties(household_id, id),
  CONSTRAINT journal_drafts_artifact_fk
    FOREIGN KEY (household_id, task_id, checked_artifact_id, checked_artifact_hash)
    REFERENCES operations.artifacts(household_id, task_id, artifact_id, artifact_hash),
  CONSTRAINT journal_drafts_version_link_shape CHECK (
    (version = 1 AND previous_draft_id IS NULL)
    OR (version > 1 AND previous_draft_id IS NOT NULL)
  )
);

CREATE TABLE accounting.draft_postings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id bigint NOT NULL,
  draft_id bigint NOT NULL,
  ordinal integer NOT NULL CONSTRAINT draft_postings_ordinal_positive CHECK (ordinal > 0),
  account_id bigint NOT NULL,
  direction text NOT NULL CONSTRAINT draft_postings_direction CHECK (direction IN ('debit','credit')),
  transaction_amount operations.decimal_amount NOT NULL
    CONSTRAINT draft_postings_transaction_nonnegative CHECK (transaction_amount >= 0),
  account_native_amount operations.decimal_amount NOT NULL
    CONSTRAINT draft_postings_native_nonnegative CHECK (account_native_amount >= 0),
  account_native_currency operations.currency_code NOT NULL,
  exchange_rate numeric(38,18),
  exchange_rate_quote text,
  exchange_rate_date date,
  exchange_rate_source text,
  memo text,
  tag_ids text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT draft_postings_ordinal_unique UNIQUE (household_id, draft_id, ordinal),
  CONSTRAINT draft_postings_draft_fk FOREIGN KEY (household_id, draft_id)
    REFERENCES accounting.journal_drafts(household_id, id),
  CONSTRAINT draft_postings_account_fk FOREIGN KEY (household_id, account_id)
    REFERENCES accounting.accounts(household_id, id),
  CONSTRAINT draft_postings_rate_shape CHECK (
    (exchange_rate IS NULL AND exchange_rate_quote IS NULL
      AND exchange_rate_date IS NULL AND exchange_rate_source IS NULL)
    OR (exchange_rate > 0
      AND exchange_rate_quote IN ('native_per_transaction','transaction_per_native')
      AND exchange_rate_date IS NOT NULL AND btrim(exchange_rate_source) <> '')
  )
);

CREATE TABLE accounting.journals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  journal_id text NOT NULL CONSTRAINT journals_public_id_format
    CHECK (journal_id ~ '^journal_[0-9A-HJKMNP-TV-Z]{26}$'),
  household_id bigint NOT NULL,
  book_id bigint NOT NULL,
  period_id bigint NOT NULL,
  draft_id bigint NOT NULL,
  task_id text NOT NULL,
  checked_artifact_id text NOT NULL,
  checked_artifact_hash text NOT NULL CONSTRAINT journals_hash_format
    CHECK (checked_artifact_hash ~ '^[0-9a-f]{64}$'),
  journal_type text NOT NULL CONSTRAINT journals_type
    CHECK (journal_type IN ('ordinary','transfer','reversal','replacement','adjustment','fx_realized')),
  transaction_currency operations.currency_code NOT NULL
    REFERENCES operations.currency_metadata(currency_code),
  occurred_on date NOT NULL,
  effective_on date NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settlement_on date,
  source_on date,
  description text NOT NULL CONSTRAINT journals_description_nonempty CHECK (btrim(description) <> ''),
  counterparty_id bigint,
  reverses_journal_id bigint,
  replaces_journal_id bigint,
  CONSTRAINT journals_public_id_unique UNIQUE (journal_id),
  CONSTRAINT journals_draft_posted_once UNIQUE (household_id, draft_id),
  CONSTRAINT journals_household_public_unique UNIQUE (household_id, journal_id),
  CONSTRAINT journals_household_internal_unique UNIQUE (household_id, id),
  CONSTRAINT journals_book_fk FOREIGN KEY (household_id, book_id)
    REFERENCES accounting.books(household_id, id),
  CONSTRAINT journals_period_fk FOREIGN KEY (household_id, book_id, period_id)
    REFERENCES accounting.periods(household_id, book_id, id),
  CONSTRAINT journals_exact_draft_fk
    FOREIGN KEY (household_id, book_id, draft_id, task_id, checked_artifact_id, checked_artifact_hash)
    REFERENCES accounting.journal_drafts
      (household_id, book_id, id, task_id, checked_artifact_id, checked_artifact_hash),
  CONSTRAINT journals_counterparty_fk FOREIGN KEY (household_id, counterparty_id)
    REFERENCES accounting.counterparties(household_id, id),
  CONSTRAINT journals_reverses_fk FOREIGN KEY (household_id, reverses_journal_id)
    REFERENCES accounting.journals(household_id, id),
  CONSTRAINT journals_replaces_fk FOREIGN KEY (household_id, replaces_journal_id)
    REFERENCES accounting.journals(household_id, id),
  CONSTRAINT journals_correction_shape CHECK (
    (journal_type = 'reversal' AND reverses_journal_id IS NOT NULL AND replaces_journal_id IS NULL)
    OR (journal_type = 'replacement' AND replaces_journal_id IS NOT NULL AND reverses_journal_id IS NULL)
    OR (journal_type NOT IN ('reversal','replacement')
      AND reverses_journal_id IS NULL AND replaces_journal_id IS NULL)
  ),
  CONSTRAINT journals_not_self_correction CHECK (
    (reverses_journal_id IS NULL OR reverses_journal_id <> id)
    AND (replaces_journal_id IS NULL OR replaces_journal_id <> id)
  )
);

CREATE TABLE accounting.postings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  posting_id text NOT NULL CONSTRAINT postings_public_id_format
    CHECK (posting_id ~ '^posting_[0-9A-HJKMNP-TV-Z]{26}$'),
  household_id bigint NOT NULL,
  journal_id bigint NOT NULL,
  ordinal integer NOT NULL CONSTRAINT postings_ordinal_positive CHECK (ordinal > 0),
  account_id bigint NOT NULL,
  direction text NOT NULL CONSTRAINT postings_direction CHECK (direction IN ('debit','credit')),
  transaction_amount operations.decimal_amount NOT NULL
    CONSTRAINT postings_transaction_positive CHECK (transaction_amount > 0),
  account_native_amount operations.decimal_amount NOT NULL
    CONSTRAINT postings_native_positive CHECK (account_native_amount > 0),
  account_native_currency operations.currency_code NOT NULL,
  exchange_rate numeric(38,18),
  exchange_rate_quote text,
  exchange_rate_date date,
  exchange_rate_source text,
  memo text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT postings_public_id_unique UNIQUE (posting_id),
  CONSTRAINT postings_household_public_unique UNIQUE (household_id, posting_id),
  CONSTRAINT postings_household_internal_unique UNIQUE (household_id, id),
  CONSTRAINT postings_journal_ordinal_unique UNIQUE (household_id, journal_id, ordinal),
  CONSTRAINT postings_journal_fk FOREIGN KEY (household_id, journal_id)
    REFERENCES accounting.journals(household_id, id),
  CONSTRAINT postings_account_fk FOREIGN KEY (household_id, account_id)
    REFERENCES accounting.accounts(household_id, id),
  CONSTRAINT postings_rate_shape CHECK (
    (exchange_rate IS NULL AND exchange_rate_quote IS NULL
      AND exchange_rate_date IS NULL AND exchange_rate_source IS NULL)
    OR (exchange_rate > 0
      AND exchange_rate_quote IN ('native_per_transaction','transaction_per_native')
      AND exchange_rate_date IS NOT NULL AND btrim(exchange_rate_source) <> '')
  )
);

CREATE TABLE accounting.journal_tags (
  household_id bigint NOT NULL,
  journal_id bigint NOT NULL,
  tag_id bigint NOT NULL,
  PRIMARY KEY (household_id, journal_id, tag_id),
  CONSTRAINT journal_tags_journal_fk FOREIGN KEY (household_id, journal_id)
    REFERENCES accounting.journals(household_id, id),
  CONSTRAINT journal_tags_tag_fk FOREIGN KEY (household_id, tag_id)
    REFERENCES accounting.tags(household_id, id)
);

CREATE TABLE accounting.posting_tags (
  household_id bigint NOT NULL,
  posting_id bigint NOT NULL,
  tag_id bigint NOT NULL,
  PRIMARY KEY (household_id, posting_id, tag_id),
  CONSTRAINT posting_tags_posting_fk FOREIGN KEY (household_id, posting_id)
    REFERENCES accounting.postings(household_id, id),
  CONSTRAINT posting_tags_tag_fk FOREIGN KEY (household_id, tag_id)
    REFERENCES accounting.tags(household_id, id)
);

CREATE UNIQUE INDEX account_source_mappings_active_identity
  ON accounting.account_source_mappings
    (household_id, source_system, external_account_id)
  WHERE archived_at IS NULL;

CREATE FUNCTION accounting.reject_immutable_fact_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || ' is immutable';
END;
$$;

CREATE FUNCTION accounting.validate_draft_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, accounting
AS $$
DECLARE
  previous accounting.journal_drafts%ROWTYPE;
BEGIN
  IF NEW.version = 1 THEN
    RETURN NEW;
  END IF;
  SELECT * INTO previous
  FROM accounting.journal_drafts
  WHERE household_id = NEW.household_id AND id = NEW.previous_draft_id;
  IF NOT FOUND
    OR previous.book_id <> NEW.book_id
    OR previous.draft_series_id <> NEW.draft_series_id
    OR previous.version <> NEW.version - 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'journal_drafts_previous_version_exact',
      MESSAGE = 'Draft revision must reference the immediately preceding version in the same household book';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION accounting.guard_account_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, accounting
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM accounting.postings WHERE household_id = OLD.household_id AND account_id = OLD.id
  ) AND (
    NEW.household_id <> OLD.household_id OR NEW.book_id <> OLD.book_id
    OR NEW.account_id <> OLD.account_id OR NEW.native_currency <> OLD.native_currency
    OR NEW.accounting_class <> OLD.accounting_class OR NEW.normal_balance <> OLD.normal_balance
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', CONSTRAINT = 'accounts_posted_identity_immutable',
      MESSAGE = 'Posted account identity, class, balance direction, book, and currency are immutable';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION accounting.validate_account_hierarchy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, accounting
AS $$
BEGIN
  IF NEW.parent_account_id IS NULL THEN RETURN NEW; END IF;
  IF EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_account_id
      FROM accounting.accounts
      WHERE household_id = NEW.household_id AND book_id = NEW.book_id
        AND id = NEW.parent_account_id
      UNION ALL
      SELECT parent.id, parent.parent_account_id
      FROM accounting.accounts parent
      JOIN ancestors child ON child.parent_account_id = parent.id
      WHERE parent.household_id = NEW.household_id AND parent.book_id = NEW.book_id
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'accounts_hierarchy_acyclic',
      MESSAGE = 'Account hierarchy cannot contain a cycle';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER journal_drafts_validate_revision
BEFORE INSERT ON accounting.journal_drafts
FOR EACH ROW EXECUTE FUNCTION accounting.validate_draft_revision();

CREATE TRIGGER accounts_guard_history
BEFORE UPDATE ON accounting.accounts
FOR EACH ROW EXECUTE FUNCTION accounting.guard_account_history();
CREATE TRIGGER accounts_validate_hierarchy
BEFORE INSERT OR UPDATE OF parent_account_id ON accounting.accounts
FOR EACH ROW EXECUTE FUNCTION accounting.validate_account_hierarchy();

CREATE TRIGGER book_configurations_immutable
BEFORE UPDATE OR DELETE ON accounting.book_configurations
FOR EACH ROW EXECUTE FUNCTION accounting.reject_immutable_fact_change();
CREATE TRIGGER journal_drafts_immutable
BEFORE UPDATE OR DELETE ON accounting.journal_drafts
FOR EACH ROW EXECUTE FUNCTION accounting.reject_immutable_fact_change();
CREATE TRIGGER draft_postings_immutable
BEFORE UPDATE OR DELETE ON accounting.draft_postings
FOR EACH ROW EXECUTE FUNCTION accounting.reject_immutable_fact_change();
CREATE TRIGGER journals_immutable
BEFORE UPDATE OR DELETE ON accounting.journals
FOR EACH ROW EXECUTE FUNCTION accounting.reject_immutable_fact_change();
CREATE TRIGGER postings_immutable
BEFORE UPDATE OR DELETE ON accounting.postings
FOR EACH ROW EXECUTE FUNCTION accounting.reject_immutable_fact_change();
CREATE TRIGGER journal_tags_immutable
BEFORE UPDATE OR DELETE ON accounting.journal_tags
FOR EACH ROW EXECUTE FUNCTION accounting.reject_immutable_fact_change();
CREATE TRIGGER posting_tags_immutable
BEFORE UPDATE OR DELETE ON accounting.posting_tags
FOR EACH ROW EXECUTE FUNCTION accounting.reject_immutable_fact_change();

CREATE FUNCTION accounting.validate_complete_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, accounting, operations
AS $$
DECLARE
  target_journal_id bigint;
  journal accounting.journals%ROWTYPE;
  posting_count integer;
  debit_total numeric;
  credit_total numeric;
BEGIN
  IF TG_TABLE_NAME = 'journals' THEN
    target_journal_id := NEW.id;
  ELSE
    target_journal_id := NEW.journal_id;
  END IF;
  SELECT * INTO journal FROM accounting.journals WHERE id = target_journal_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF EXISTS (
    SELECT 1 FROM accounting.journal_drafts successor
    WHERE successor.household_id = journal.household_id
      AND successor.previous_draft_id = journal.draft_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'journals_latest_draft_only',
      MESSAGE = 'Only the latest draft version may be posted';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM accounting.journal_drafts draft
    WHERE draft.id = journal.draft_id
      AND draft.household_id = journal.household_id
      AND draft.book_id = journal.book_id
      AND draft.task_id = journal.task_id
      AND draft.checked_artifact_id = journal.checked_artifact_id
      AND draft.checked_artifact_hash = journal.checked_artifact_hash
      AND draft.journal_type = journal.journal_type
      AND draft.transaction_currency = journal.transaction_currency
      AND draft.occurred_on = journal.occurred_on
      AND draft.effective_on = journal.effective_on
      AND draft.settlement_on IS NOT DISTINCT FROM journal.settlement_on
      AND draft.source_on IS NOT DISTINCT FROM journal.source_on
      AND draft.description = journal.description
      AND draft.counterparty_id IS NOT DISTINCT FROM journal.counterparty_id
      AND draft.tag_ids = ARRAY(
        SELECT tag.tag_id
        FROM accounting.journal_tags link
        JOIN accounting.tags tag ON tag.household_id = link.household_id AND tag.id = link.tag_id
        WHERE link.household_id = journal.household_id AND link.journal_id = journal.id
        ORDER BY tag.tag_id
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'journals_exact_draft_metadata',
      MESSAGE = 'Posted journal metadata and tags must exactly match the checked draft';
  END IF;

  IF EXISTS (
    (SELECT ordinal, account_id, direction, transaction_amount, account_native_amount,
       account_native_currency, exchange_rate, exchange_rate_quote, exchange_rate_date,
       exchange_rate_source, memo, tag_ids
     FROM accounting.draft_postings
     WHERE household_id = journal.household_id AND draft_id = journal.draft_id)
    EXCEPT ALL
    (SELECT posting.ordinal, posting.account_id, posting.direction, posting.transaction_amount,
       posting.account_native_amount, posting.account_native_currency, posting.exchange_rate,
       posting.exchange_rate_quote, posting.exchange_rate_date, posting.exchange_rate_source,
       posting.memo,
       ARRAY(SELECT tag.tag_id
         FROM accounting.posting_tags link
         JOIN accounting.tags tag ON tag.household_id = link.household_id AND tag.id = link.tag_id
         WHERE link.household_id = posting.household_id AND link.posting_id = posting.id
         ORDER BY tag.tag_id)
     FROM accounting.postings posting
     WHERE posting.household_id = journal.household_id AND posting.journal_id = journal.id)
  ) OR EXISTS (
    (SELECT posting.ordinal, posting.account_id, posting.direction, posting.transaction_amount,
       posting.account_native_amount, posting.account_native_currency, posting.exchange_rate,
       posting.exchange_rate_quote, posting.exchange_rate_date, posting.exchange_rate_source,
       posting.memo,
       ARRAY(SELECT tag.tag_id
         FROM accounting.posting_tags link
         JOIN accounting.tags tag ON tag.household_id = link.household_id AND tag.id = link.tag_id
         WHERE link.household_id = posting.household_id AND link.posting_id = posting.id
         ORDER BY tag.tag_id)
     FROM accounting.postings posting
     WHERE posting.household_id = journal.household_id AND posting.journal_id = journal.id)
    EXCEPT ALL
    (SELECT ordinal, account_id, direction, transaction_amount, account_native_amount,
       account_native_currency, exchange_rate, exchange_rate_quote, exchange_rate_date,
       exchange_rate_source, memo, tag_ids
     FROM accounting.draft_postings
     WHERE household_id = journal.household_id AND draft_id = journal.draft_id)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'journals_exact_draft_postings',
      MESSAGE = 'Posted journal entries must exactly match the checked draft entries';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM operations.artifacts artifact
    JOIN operations.checker_verdicts verdict
      ON verdict.household_id = artifact.household_id
     AND verdict.task_id = artifact.task_id
     AND verdict.covered_artifact_id = artifact.artifact_id
     AND verdict.covered_artifact_hash = artifact.artifact_hash
    WHERE artifact.household_id = journal.household_id
      AND artifact.task_id = journal.task_id
      AND artifact.artifact_id = journal.checked_artifact_id
      AND artifact.artifact_hash = journal.checked_artifact_hash
      AND artifact.artifact_type = 'maker_output'
      AND verdict.verdict = 'accepted'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'journals_accepted_artifact_required',
      MESSAGE = 'Journal draft artifact has no exact accepting checker verdict';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM accounting.periods period
    WHERE period.id = journal.period_id
      AND period.household_id = journal.household_id
      AND period.book_id = journal.book_id
      AND period.state = 'open'
      AND journal.effective_on BETWEEN period.period_start AND period.period_end
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'journals_open_period_required',
      MESSAGE = 'Journal effective date must belong to its open accounting period';
  END IF;

  SELECT count(*),
    coalesce(sum(transaction_amount) FILTER (WHERE direction = 'debit'), 0),
    coalesce(sum(transaction_amount) FILTER (WHERE direction = 'credit'), 0)
  INTO posting_count, debit_total, credit_total
  FROM accounting.postings
  WHERE household_id = journal.household_id AND journal_id = journal.id;

  IF posting_count < 2 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'journals_two_postings_required',
      MESSAGE = 'Posted journals require at least two postings';
  END IF;
  IF debit_total <> credit_total THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'journals_transaction_currency_balanced',
      MESSAGE = 'Journal transaction-currency debits and credits must balance';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM accounting.postings posting
    JOIN accounting.accounts account
      ON account.household_id = posting.household_id AND account.id = posting.account_id
    LEFT JOIN operations.currency_metadata native_meta
      ON native_meta.currency_code = posting.account_native_currency
    LEFT JOIN operations.currency_metadata transaction_meta
      ON transaction_meta.currency_code = journal.transaction_currency
    WHERE posting.household_id = journal.household_id AND posting.journal_id = journal.id
      AND (
        account.book_id <> journal.book_id
        OR posting.account_native_currency <> account.native_currency
        OR NOT operations.amount_matches_currency_scale(
          posting.transaction_amount, journal.transaction_currency)
        OR NOT operations.amount_matches_currency_scale(
          posting.account_native_amount, posting.account_native_currency)
        OR (
          account.native_currency = journal.transaction_currency
          AND (posting.account_native_amount <> posting.transaction_amount
            OR posting.exchange_rate IS NOT NULL)
        )
        OR (
          account.native_currency <> journal.transaction_currency
          AND (
            posting.exchange_rate IS NULL
            OR CASE posting.exchange_rate_quote
              WHEN 'native_per_transaction' THEN
                round(posting.transaction_amount * posting.exchange_rate, native_meta.decimal_scale)
                  <> posting.account_native_amount
              WHEN 'transaction_per_native' THEN
                round(posting.account_native_amount * posting.exchange_rate, transaction_meta.decimal_scale)
                  <> posting.transaction_amount
              ELSE true
            END
          )
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'postings_currency_and_book_consistent',
      MESSAGE = 'Posting account, book, currency scale, native amount, or exchange rate is invalid';
  END IF;

  IF journal.journal_type = 'transfer' AND EXISTS (
    SELECT 1 FROM accounting.postings posting
    JOIN accounting.accounts account
      ON account.household_id = posting.household_id AND account.id = posting.account_id
    WHERE posting.household_id = journal.household_id AND posting.journal_id = journal.id
      AND account.accounting_class NOT IN ('asset','liability')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'transfer_balance_sheet_accounts_only',
      MESSAGE = 'Transfers may use only asset and liability accounts';
  END IF;

  IF journal.journal_type = 'reversal' AND (
    (SELECT transaction_currency FROM accounting.journals
      WHERE household_id = journal.household_id AND id = journal.reverses_journal_id)
      <> journal.transaction_currency
    OR EXISTS (
      (SELECT account_id,
          CASE direction WHEN 'debit' THEN 'credit' ELSE 'debit' END AS direction,
          transaction_amount, account_native_amount, account_native_currency,
          exchange_rate, exchange_rate_quote, exchange_rate_date, exchange_rate_source, memo,
          ARRAY(SELECT tag.tag_id FROM accounting.posting_tags link
            JOIN accounting.tags tag ON tag.household_id = link.household_id AND tag.id = link.tag_id
            WHERE link.household_id = original.household_id AND link.posting_id = original.id
            ORDER BY tag.tag_id) AS tag_ids
       FROM accounting.postings original
       WHERE original.household_id = journal.household_id
         AND original.journal_id = journal.reverses_journal_id)
      EXCEPT ALL
      (SELECT account_id, direction, transaction_amount, account_native_amount, account_native_currency,
          exchange_rate, exchange_rate_quote, exchange_rate_date, exchange_rate_source, memo,
          ARRAY(SELECT tag.tag_id FROM accounting.posting_tags link
            JOIN accounting.tags tag ON tag.household_id = link.household_id AND tag.id = link.tag_id
            WHERE link.household_id = reversed.household_id AND link.posting_id = reversed.id
            ORDER BY tag.tag_id) AS tag_ids
       FROM accounting.postings reversed
       WHERE reversed.household_id = journal.household_id AND reversed.journal_id = journal.id)
    )
    OR EXISTS (
      (SELECT account_id, direction, transaction_amount, account_native_amount, account_native_currency,
          exchange_rate, exchange_rate_quote, exchange_rate_date, exchange_rate_source, memo,
          ARRAY(SELECT tag.tag_id FROM accounting.posting_tags link
            JOIN accounting.tags tag ON tag.household_id = link.household_id AND tag.id = link.tag_id
            WHERE link.household_id = reversed.household_id AND link.posting_id = reversed.id
            ORDER BY tag.tag_id) AS tag_ids
       FROM accounting.postings reversed
       WHERE reversed.household_id = journal.household_id AND reversed.journal_id = journal.id)
      EXCEPT ALL
      (SELECT account_id,
          CASE direction WHEN 'debit' THEN 'credit' ELSE 'debit' END AS direction,
          transaction_amount, account_native_amount, account_native_currency,
          exchange_rate, exchange_rate_quote, exchange_rate_date, exchange_rate_source, memo,
          ARRAY(SELECT tag.tag_id FROM accounting.posting_tags link
            JOIN accounting.tags tag ON tag.household_id = link.household_id AND tag.id = link.tag_id
            WHERE link.household_id = original.household_id AND link.posting_id = original.id
            ORDER BY tag.tag_id) AS tag_ids
       FROM accounting.postings original
       WHERE original.household_id = journal.household_id
         AND original.journal_id = journal.reverses_journal_id)
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'reversal_exact_opposite',
      MESSAGE = 'Reversal postings must exactly oppose the original journal';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER journals_validate_complete
AFTER INSERT ON accounting.journals
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION accounting.validate_complete_journal();

CREATE CONSTRAINT TRIGGER postings_validate_complete
AFTER INSERT ON accounting.postings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION accounting.validate_complete_journal();

CREATE INDEX book_configurations_effective_lookup
  ON accounting.book_configurations (household_id, book_id, effective_from DESC);
CREATE INDEX accounts_active_by_class
  ON accounting.accounts (household_id, book_id, accounting_class, account_id)
  WHERE archived_at IS NULL;
CREATE INDEX accounts_parent_lookup
  ON accounting.accounts (household_id, book_id, parent_account_id)
  WHERE parent_account_id IS NOT NULL;
CREATE INDEX account_source_mappings_account_lookup
  ON accounting.account_source_mappings (household_id, account_id, source_system)
  WHERE archived_at IS NULL;
CREATE INDEX periods_open_lookup
  ON accounting.periods (household_id, book_id, period_start)
  WHERE state = 'open';
CREATE INDEX journal_drafts_series_latest
  ON accounting.journal_drafts (household_id, draft_series_id, version DESC);
CREATE INDEX journals_household_effective
  ON accounting.journals (household_id, effective_on DESC, journal_id);
CREATE INDEX journals_household_period
  ON accounting.journals (household_id, period_id, effective_on);
CREATE UNIQUE INDEX journals_one_reversal_per_original
  ON accounting.journals (household_id, reverses_journal_id)
  WHERE reverses_journal_id IS NOT NULL;
CREATE UNIQUE INDEX journals_one_replacement_per_original
  ON accounting.journals (household_id, replaces_journal_id)
  WHERE replaces_journal_id IS NOT NULL;
CREATE INDEX postings_account_journal
  ON accounting.postings (household_id, account_id, journal_id);

ALTER TABLE accounting.books OWNER TO plus_one_owner;
ALTER TABLE accounting.book_configurations OWNER TO plus_one_owner;
ALTER TABLE accounting.accounts OWNER TO plus_one_owner;
ALTER TABLE accounting.account_source_mappings OWNER TO plus_one_owner;
ALTER TABLE accounting.periods OWNER TO plus_one_owner;
ALTER TABLE accounting.counterparties OWNER TO plus_one_owner;
ALTER TABLE accounting.tags OWNER TO plus_one_owner;
ALTER TABLE accounting.journal_drafts OWNER TO plus_one_owner;
ALTER TABLE accounting.draft_postings OWNER TO plus_one_owner;
ALTER TABLE accounting.journals OWNER TO plus_one_owner;
ALTER TABLE accounting.postings OWNER TO plus_one_owner;
ALTER TABLE accounting.journal_tags OWNER TO plus_one_owner;
ALTER TABLE accounting.posting_tags OWNER TO plus_one_owner;
ALTER FUNCTION accounting.reject_immutable_fact_change() OWNER TO plus_one_owner;
ALTER FUNCTION accounting.validate_draft_revision() OWNER TO plus_one_owner;
ALTER FUNCTION accounting.guard_account_history() OWNER TO plus_one_owner;
ALTER FUNCTION accounting.validate_account_hierarchy() OWNER TO plus_one_owner;
ALTER FUNCTION accounting.validate_complete_journal() OWNER TO plus_one_owner;

REVOKE ALL ON ALL TABLES IN SCHEMA accounting FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA accounting FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA accounting FROM PUBLIC;

GRANT SELECT, INSERT ON
  accounting.books, accounting.accounts, accounting.account_source_mappings, accounting.periods,
  accounting.counterparties, accounting.tags,
  accounting.book_configurations, accounting.journal_drafts, accounting.draft_postings,
  accounting.journals, accounting.postings, accounting.journal_tags, accounting.posting_tags
TO plus_one_accounting;
GRANT UPDATE (parent_account_id, name, purpose, accounting_class, normal_balance,
  native_currency, ownership_label, archived_at, updated_at)
  ON accounting.accounts TO plus_one_accounting;
GRANT UPDATE (archived_at) ON accounting.account_source_mappings TO plus_one_accounting;
GRANT UPDATE (state, closed_at, reopened_at, updated_at)
  ON accounting.periods TO plus_one_accounting;
GRANT UPDATE (display_name, archived_at, updated_at)
  ON accounting.counterparties TO plus_one_accounting;
GRANT UPDATE (name, archived_at, updated_at)
  ON accounting.tags TO plus_one_accounting;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA accounting TO plus_one_accounting;
GRANT USAGE ON SCHEMA accounting TO plus_one_accounting;
GRANT USAGE ON SCHEMA operations TO plus_one_accounting;
GRANT SELECT ON operations.households, operations.currency_metadata TO plus_one_accounting;

REVOKE ALL ON ALL TABLES IN SCHEMA accounting FROM plus_one_query, plus_one_planning, plus_one_operations;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA accounting FROM plus_one_query, plus_one_planning, plus_one_operations;

ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner IN SCHEMA accounting
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner IN SCHEMA accounting
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner IN SCHEMA accounting
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMIT;
RESET ROLE;
