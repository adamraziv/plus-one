SET ROLE plus_one_owner;

ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner IN SCHEMA mastra_memory
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO plus_one_memory;

CREATE TABLE IF NOT EXISTS mastra_memory.mastra_threads (
  id text PRIMARY KEY NOT NULL,
  "resourceId" text NOT NULL,
  title text NOT NULL,
  metadata jsonb,
  "createdAt" timestamp NOT NULL,
  "updatedAt" timestamp NOT NULL,
  "createdAtZ" timestamptz DEFAULT NOW(),
  "updatedAtZ" timestamptz DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mastra_memory.mastra_messages (
  id text PRIMARY KEY NOT NULL,
  thread_id text NOT NULL,
  content text NOT NULL,
  role text NOT NULL,
  type text NOT NULL,
  "createdAt" timestamp NOT NULL,
  "resourceId" text,
  "createdAtZ" timestamptz DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mastra_memory.mastra_resources (
  id text PRIMARY KEY NOT NULL,
  "workingMemory" text,
  metadata jsonb,
  "createdAt" timestamp NOT NULL,
  "updatedAt" timestamp NOT NULL,
  "createdAtZ" timestamptz DEFAULT NOW(),
  "updatedAtZ" timestamptz DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mastra_memory_mastra_threads_resourceid_createdat_idx
  ON mastra_memory.mastra_threads ("resourceId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS mastra_memory_mastra_messages_thread_id_createdat_idx
  ON mastra_memory.mastra_messages (thread_id, "createdAt" DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mastra_memory TO plus_one_memory;

RESET ROLE;
