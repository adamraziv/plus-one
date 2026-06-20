SET ROLE plus_one_owner;
BEGIN;
SET LOCAL search_path = pg_catalog, planning, operations;

CREATE TABLE planning.budget_scopes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id bigint NOT NULL REFERENCES operations.households(id),
  scope_key text NOT NULL CHECK (btrim(scope_key) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (household_id, id)
);
CREATE UNIQUE INDEX budget_scopes_active_key_unique ON planning.budget_scopes(household_id, scope_key) WHERE archived_at IS NULL;

CREATE TABLE planning.budget_categories (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id bigint NOT NULL REFERENCES operations.households(id),
  category_key text NOT NULL CHECK (btrim(category_key) <> ''),
  parent_category_id bigint,
  name text NOT NULL CHECK (btrim(name) <> ''),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, parent_category_id) REFERENCES planning.budget_categories(household_id, id)
);
CREATE UNIQUE INDEX budget_categories_active_key_unique ON planning.budget_categories(household_id, category_key) WHERE archived_at IS NULL;

CREATE TABLE planning.budget_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id bigint NOT NULL REFERENCES operations.households(id),
  scope_id bigint NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> ''),
  valid_from date NOT NULL,
  valid_to date,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, scope_id) REFERENCES planning.budget_scopes(household_id, id)
);
CREATE INDEX budget_versions_household_scope_dates_idx ON planning.budget_versions(household_id, scope_id, valid_from, valid_to);

CREATE TABLE planning.budget_allocations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id bigint NOT NULL,
  budget_version_id bigint NOT NULL,
  category_id bigint NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  amount operations.decimal_amount NOT NULL CHECK (amount >= 0),
  currency operations.currency_code NOT NULL REFERENCES operations.currency_metadata(currency_code),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (period_end >= period_start),
  FOREIGN KEY (household_id, budget_version_id) REFERENCES planning.budget_versions(household_id, id),
  FOREIGN KEY (household_id, category_id) REFERENCES planning.budget_categories(household_id, id)
);
CREATE INDEX budget_allocations_household_period_idx ON planning.budget_allocations(household_id, period_start, period_end);

CREATE TABLE planning.budget_category_account_mappings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id bigint NOT NULL,
  category_id bigint NOT NULL,
  account_id bigint NOT NULL,
  direction text NOT NULL CHECK (direction IN ('income','expense','transfer')),
  valid_from date NOT NULL,
  valid_to date,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  FOREIGN KEY (household_id, category_id) REFERENCES planning.budget_categories(household_id, id),
  FOREIGN KEY (household_id, account_id) REFERENCES accounting.accounts(household_id, id)
);
CREATE INDEX budget_mappings_household_account_dates_idx ON planning.budget_category_account_mappings(household_id, account_id, valid_from, valid_to);

CREATE TABLE planning.recurring_obligations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id bigint NOT NULL REFERENCES operations.households(id),
  obligation_key text NOT NULL CHECK (btrim(obligation_key) <> ''),
  variant text NOT NULL CHECK (variant IN ('bill','subscription')),
  name text NOT NULL CHECK (btrim(name) <> ''),
  lifecycle_status text NOT NULL CHECK (lifecycle_status IN ('active','paused','ended')),
  recurrence jsonb NOT NULL CHECK (jsonb_typeof(recurrence) = 'object'),
  expected_amount operations.decimal_amount NOT NULL CHECK (expected_amount >= 0),
  expected_currency operations.currency_code NOT NULL REFERENCES operations.currency_metadata(currency_code),
  due_day integer NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  counterparty_name text,
  account_id bigint,
  budget_category_id bigint,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, account_id) REFERENCES accounting.accounts(household_id, id),
  FOREIGN KEY (household_id, budget_category_id) REFERENCES planning.budget_categories(household_id, id)
);
CREATE UNIQUE INDEX recurring_obligations_active_key_unique ON planning.recurring_obligations(household_id, obligation_key) WHERE archived_at IS NULL;

CREATE TABLE planning.obligation_occurrences (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id bigint NOT NULL,
  obligation_id bigint NOT NULL,
  occurrence_date date NOT NULL,
  due_date date NOT NULL,
  expected_amount operations.decimal_amount NOT NULL CHECK (expected_amount >= 0),
  expected_currency operations.currency_code NOT NULL REFERENCES operations.currency_metadata(currency_code),
  status text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected','skipped','settled')),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (household_id, obligation_id, occurrence_date),
  FOREIGN KEY (household_id, obligation_id) REFERENCES planning.recurring_obligations(household_id, id)
);
CREATE INDEX obligation_occurrences_household_due_idx ON planning.obligation_occurrences(household_id, due_date);

CREATE TABLE planning.savings_goals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id bigint NOT NULL REFERENCES operations.households(id),
  goal_key text NOT NULL CHECK (btrim(goal_key) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  target_amount operations.decimal_amount NOT NULL CHECK (target_amount >= 0),
  target_currency operations.currency_code NOT NULL REFERENCES operations.currency_metadata(currency_code),
  target_date date,
  budget_category_id bigint,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, budget_category_id) REFERENCES planning.budget_categories(household_id, id)
);
CREATE UNIQUE INDEX savings_goals_active_key_unique ON planning.savings_goals(household_id, goal_key) WHERE archived_at IS NULL;

CREATE TABLE planning.savings_goal_accounts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id bigint NOT NULL,
  goal_id bigint NOT NULL,
  account_id bigint NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (household_id, goal_id) REFERENCES planning.savings_goals(household_id, id),
  FOREIGN KEY (household_id, account_id) REFERENCES accounting.accounts(household_id, id)
);
CREATE UNIQUE INDEX savings_goal_accounts_active_unique ON planning.savings_goal_accounts(household_id, goal_id, account_id) WHERE archived_at IS NULL;

CREATE TABLE planning.virtual_allocations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id bigint NOT NULL,
  goal_id bigint NOT NULL,
  account_id bigint NOT NULL,
  allocation_key text NOT NULL CHECK (btrim(allocation_key) <> ''),
  amount operations.decimal_amount NOT NULL CHECK (amount >= 0),
  currency operations.currency_code NOT NULL REFERENCES operations.currency_metadata(currency_code),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (household_id, goal_id) REFERENCES planning.savings_goals(household_id, id),
  FOREIGN KEY (household_id, account_id) REFERENCES accounting.accounts(household_id, id)
);
CREATE UNIQUE INDEX virtual_allocations_active_account_key_unique ON planning.virtual_allocations(household_id, account_id, allocation_key) WHERE archived_at IS NULL;

CREATE TABLE planning.loan_agreements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id bigint NOT NULL REFERENCES operations.households(id),
  liability_account_id bigint NOT NULL,
  lender_name text NOT NULL CHECK (btrim(lender_name) <> ''),
  principal_amount operations.decimal_amount NOT NULL CHECK (principal_amount >= 0),
  principal_currency operations.currency_code NOT NULL REFERENCES operations.currency_metadata(currency_code),
  annual_interest_rate numeric(18, 8) NOT NULL CHECK (annual_interest_rate >= 0),
  effective_from date NOT NULL,
  payment_schedule jsonb NOT NULL CHECK (jsonb_typeof(payment_schedule) = 'object'),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, liability_account_id) REFERENCES accounting.accounts(household_id, id)
);
CREATE INDEX loan_agreements_household_account_idx ON planning.loan_agreements(household_id, liability_account_id, effective_from);

CREATE TABLE planning.debt_plans (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id bigint NOT NULL REFERENCES operations.households(id),
  debt_plan_key text NOT NULL CHECK (btrim(debt_plan_key) <> ''),
  liability_account_id bigint NOT NULL,
  loan_agreement_id bigint NOT NULL,
  budget_category_id bigint,
  name text NOT NULL CHECK (btrim(name) <> ''),
  monthly_payment_amount operations.decimal_amount NOT NULL CHECK (monthly_payment_amount >= 0),
  monthly_payment_currency operations.currency_code NOT NULL REFERENCES operations.currency_metadata(currency_code),
  priority integer NOT NULL CHECK (priority > 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, liability_account_id) REFERENCES accounting.accounts(household_id, id),
  FOREIGN KEY (household_id, loan_agreement_id) REFERENCES planning.loan_agreements(household_id, id),
  FOREIGN KEY (household_id, budget_category_id) REFERENCES planning.budget_categories(household_id, id)
);
CREATE UNIQUE INDEX debt_plans_active_key_unique ON planning.debt_plans(household_id, debt_plan_key) WHERE archived_at IS NULL;

CREATE TABLE planning.domain_audit_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id bigint NOT NULL REFERENCES operations.households(id),
  entity_table text NOT NULL CHECK (btrim(entity_table) <> ''),
  entity_id bigint NOT NULL,
  action text NOT NULL CHECK (action IN ('created','updated','archived')),
  command_id text NOT NULL CHECK (command_id ~ '^command_[0-9A-HJKMNP-TV-Z]{26}$'),
  checked_proposal_id text NOT NULL CHECK (checked_proposal_id ~ '^artifact_[0-9A-HJKMNP-TV-Z]{26}$'),
  checked_proposal_hash text NOT NULL CHECK (checked_proposal_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX domain_audit_records_household_entity_idx ON planning.domain_audit_records(household_id, entity_table, entity_id, created_at);

CREATE FUNCTION planning.prevent_domain_audit_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'planning domain audit records are append-only';
END;
$$;

CREATE TRIGGER domain_audit_records_no_update
  BEFORE UPDATE OR DELETE ON planning.domain_audit_records
  FOR EACH ROW EXECUTE FUNCTION planning.prevent_domain_audit_change();

CREATE FUNCTION planning.prevent_budget_version_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, planning
AS $$
BEGIN
  IF NEW.archived_at IS NULL AND EXISTS (
    SELECT 1 FROM planning.budget_versions existing
    WHERE existing.household_id = NEW.household_id
      AND existing.scope_id = NEW.scope_id
      AND existing.archived_at IS NULL
      AND existing.id <> NEW.id
      AND daterange(existing.valid_from, COALESCE(existing.valid_to, 'infinity'::date), '[]')
        && daterange(NEW.valid_from, COALESCE(NEW.valid_to, 'infinity'::date), '[]')
  ) THEN
    RAISE EXCEPTION 'active budget versions cannot overlap';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER budget_versions_no_active_overlap
  BEFORE INSERT OR UPDATE ON planning.budget_versions
  FOR EACH ROW EXECUTE FUNCTION planning.prevent_budget_version_overlap();

CREATE FUNCTION planning.prevent_budget_mapping_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, planning
AS $$
BEGIN
  IF NEW.archived_at IS NULL AND EXISTS (
    SELECT 1 FROM planning.budget_category_account_mappings existing
    WHERE existing.household_id = NEW.household_id
      AND existing.category_id = NEW.category_id
      AND existing.account_id = NEW.account_id
      AND existing.archived_at IS NULL
      AND existing.id <> NEW.id
      AND daterange(existing.valid_from, COALESCE(existing.valid_to, 'infinity'::date), '[]')
        && daterange(NEW.valid_from, COALESCE(NEW.valid_to, 'infinity'::date), '[]')
  ) THEN
    RAISE EXCEPTION 'active budget category mappings cannot overlap';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER budget_mappings_no_active_overlap
  BEFORE INSERT OR UPDATE ON planning.budget_category_account_mappings
  FOR EACH ROW EXECUTE FUNCTION planning.prevent_budget_mapping_overlap();

GRANT SELECT ON operations.households, operations.currency_metadata TO plus_one_planning;
GRANT SELECT ON accounting.accounts TO plus_one_planning;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA planning TO plus_one_planning;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA planning TO plus_one_planning;

COMMIT;
RESET ROLE;
