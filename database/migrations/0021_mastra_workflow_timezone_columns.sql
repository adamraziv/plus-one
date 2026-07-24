SET ROLE plus_one_owner;

ALTER TABLE mastra_memory.mastra_workflow_snapshot
  ADD COLUMN IF NOT EXISTS "createdAtZ" timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "updatedAtZ" timestamptz DEFAULT now();

UPDATE mastra_memory.mastra_workflow_snapshot
SET "createdAtZ" = COALESCE("createdAtZ", "createdAt"),
    "updatedAtZ" = COALESCE("updatedAtZ", "updatedAt");

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE mastra_memory.mastra_workflow_snapshot TO plus_one_memory;

RESET ROLE;
