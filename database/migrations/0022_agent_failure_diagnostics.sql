ALTER TABLE operations.agent_runs
  ADD COLUMN failure_code text,
  ADD COLUMN retry_directive text,
  ADD CONSTRAINT agent_runs_failure_code_format CHECK (
    failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{1,160}$'
  ),
  ADD CONSTRAINT agent_runs_retry_directive_format CHECK (
    retry_directive IS NULL OR retry_directive ~ '^[a-z0-9_]{1,80}$'
  );

ALTER TABLE operations.agent_attempts
  ADD COLUMN failure_code text,
  ADD COLUMN retry_directive text,
  ADD CONSTRAINT agent_attempts_failure_code_format CHECK (
    failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{1,160}$'
  ),
  ADD CONSTRAINT agent_attempts_retry_directive_format CHECK (
    retry_directive IS NULL OR retry_directive ~ '^[a-z0-9_]{1,80}$'
  );
