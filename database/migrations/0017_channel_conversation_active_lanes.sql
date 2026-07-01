SET ROLE plus_one_owner;

ALTER TABLE operations.channel_conversations
  DROP CONSTRAINT channel_conversations_platform_unique;

CREATE INDEX channel_conversations_platform_idx
  ON operations.channel_conversations (
    household_id, channel, external_conversation_id, external_thread_id, created_at
  );

CREATE TABLE operations.channel_conversation_active_lanes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id bigint NOT NULL REFERENCES operations.households(id),
  channel text NOT NULL CONSTRAINT channel_conversation_active_lanes_channel CHECK (channel IN ('telegram', 'slack')),
  external_conversation_id text NOT NULL,
  external_thread_id text NOT NULL DEFAULT '',
  active_conversation_id bigint NOT NULL REFERENCES operations.channel_conversations(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT channel_conversation_active_lanes_unique UNIQUE (
    household_id, channel, external_conversation_id, external_thread_id
  )
);

CREATE INDEX channel_conversation_active_lanes_active_conversation_idx
  ON operations.channel_conversation_active_lanes (active_conversation_id);

GRANT SELECT, INSERT, UPDATE ON operations.channel_conversation_active_lanes TO plus_one_operations;
GRANT USAGE, SELECT ON SEQUENCE operations.channel_conversation_active_lanes_id_seq TO plus_one_operations;

REVOKE ALL ON operations.channel_conversation_active_lanes
  FROM plus_one_query, plus_one_accounting, plus_one_planning, plus_one_memory;
REVOKE ALL ON SEQUENCE operations.channel_conversation_active_lanes_id_seq
  FROM plus_one_query, plus_one_accounting, plus_one_planning, plus_one_memory;

RESET ROLE;
