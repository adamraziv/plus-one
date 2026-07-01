SET ROLE plus_one_owner;

ALTER DEFAULT PRIVILEGES FOR ROLE plus_one_owner IN SCHEMA mastra_memory
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO plus_one_memory;

CREATE TABLE IF NOT EXISTS mastra_memory.mastra_observational_memory (
  id text PRIMARY KEY NOT NULL,
  "lookupKey" text NOT NULL,
  scope text NOT NULL,
  "resourceId" text,
  "threadId" text,
  "activeObservations" text NOT NULL,
  "activeObservationsPendingUpdate" text,
  "originType" text NOT NULL,
  config text NOT NULL,
  "generationCount" integer NOT NULL,
  "lastObservedAt" timestamp,
  "lastObservedAtZ" timestamptz,
  "lastReflectionAt" timestamp,
  "lastReflectionAtZ" timestamptz,
  "pendingMessageTokens" integer NOT NULL,
  "totalTokensObserved" integer NOT NULL,
  "observationTokenCount" integer NOT NULL,
  "isObserving" boolean NOT NULL DEFAULT false,
  "isReflecting" boolean NOT NULL DEFAULT false,
  "observedMessageIds" jsonb,
  "observedTimezone" text,
  "bufferedObservations" text,
  "bufferedObservationTokens" integer,
  "bufferedMessageIds" jsonb,
  "bufferedReflection" text,
  "bufferedReflectionTokens" integer,
  "bufferedReflectionInputTokens" integer,
  "reflectedObservationLineCount" integer,
  "bufferedObservationChunks" jsonb,
  "isBufferingObservation" boolean NOT NULL DEFAULT false,
  "isBufferingReflection" boolean NOT NULL DEFAULT false,
  "lastBufferedAtTokens" integer NOT NULL DEFAULT 0,
  "lastBufferedAtTime" timestamp,
  metadata jsonb,
  "createdAt" timestamp NOT NULL,
  "createdAtZ" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL,
  "updatedAtZ" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mastra_memory_mastra_observational_memory_lookup_key_idx
  ON mastra_memory.mastra_observational_memory ("lookupKey");

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mastra_memory TO plus_one_memory;

RESET ROLE;
