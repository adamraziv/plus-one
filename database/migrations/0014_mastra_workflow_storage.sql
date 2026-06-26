SET ROLE plus_one_owner;

ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner IN SCHEMA mastra_memory
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO plus_one_memory;

CREATE TABLE IF NOT EXISTS mastra_memory.mastra_workflow_snapshot (
  workflow_name text NOT NULL,
  run_id text NOT NULL,
  "resourceId" text NULL,
  snapshot jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_name, run_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mastra_memory TO plus_one_memory;

RESET ROLE;
