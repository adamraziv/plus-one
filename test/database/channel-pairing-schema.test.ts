import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;

afterEach(async () => {
  await context?.cleanup();
  context = undefined;
});

describe('channel pairing schema', () => {
  it('creates pairing tables with operations-only write access', async () => {
    context = await createPostgresTestContext('channel_pairing_schema');
    const migrator = new Pool({ connectionString: context.migratorUrl });
    const operations = new Pool({ connectionString: context.roleUrls.operations });
    const query = new Pool({ connectionString: context.roleUrls.query });

    try {
      const tables = await migrator.query<{ relation: string }>(
        `SELECT to_regclass('operations.channel_principals')::text AS relation
         UNION ALL
         SELECT to_regclass('operations.channel_pairing_requests')::text AS relation`,
      );

      expect(tables.rows.map((row) => row.relation).sort()).toEqual([
        'operations.channel_pairing_requests',
        'operations.channel_principals',
      ]);

      await expect(operations.query(
        `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
         VALUES ('hh_01JNZQ4A9B8C7D6E5F4G3H2J1K', 'USD', 'UTC')`,
      )).resolves.toBeDefined();

      await expect(operations.query(
        `INSERT INTO operations.channel_pairing_requests
         (channel, external_user_id, external_chat_id, code_hash, code_salt,
          display_name, username, expires_at, metadata)
         VALUES ('telegram', '1234567890123', '9876543210987', repeat('a', 64), repeat('b', 32),
                 'Ada Lovelace', 'ada', clock_timestamp() + interval '1 hour', '{}')`,
      )).resolves.toBeDefined();

      await expect(query.query(
        'SELECT * FROM operations.channel_pairing_requests',
      )).rejects.toMatchObject({ code: '42501' });
    } finally {
      await migrator.end();
      await operations.end();
      await query.end();
    }
  });

  it('allows only one active principal for a Telegram user', async () => {
    context = await createPostgresTestContext('channel_pairing_unique_principal');
    const operations = new Pool({ connectionString: context.roleUrls.operations });

    try {
      await operations.query(
        `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
         VALUES ('hh_01JNZQ4A9B8C7D6E5F4G3H2J1K', 'USD', 'UTC')`,
      );

      await operations.query(
        `INSERT INTO operations.channel_principals
         (channel, external_user_id, external_chat_id, household_id, display_name, username,
          approved_by, metadata)
         SELECT 'telegram', '1234567890123', '9876543210987', id,
                'Ada Lovelace', 'ada', 'cli:test', '{}'
         FROM operations.households
         WHERE household_id = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K'`,
      );

      await expect(operations.query(
        `INSERT INTO operations.channel_principals
         (channel, external_user_id, external_chat_id, household_id, display_name, username,
          approved_by, metadata)
         SELECT 'telegram', '1234567890123', '9876543210987', id,
                'Ada Duplicate', 'ada2', 'cli:test', '{}'
         FROM operations.households
         WHERE household_id = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K'`,
      )).rejects.toBeDefined();
    } finally {
      await operations.end();
    }
  });
});
