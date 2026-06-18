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

COMMIT;
RESET ROLE;
