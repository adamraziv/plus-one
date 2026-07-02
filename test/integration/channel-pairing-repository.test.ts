import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresChannelPairingRepository } from '@plus-one/database';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;

afterEach(async () => {
  await context?.cleanup();
  context = undefined;
});

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';

async function seedHousehold(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1, 'USD', 'UTC')`,
    [householdId],
  );
}

describe('PostgresChannelPairingRepository', () => {
  it('stores a pending request, approves it, resolves the principal, and revokes it', async () => {
    context = await createPostgresTestContext('channel_pairing_repository');
    const pool = new Pool({ connectionString: context.roleUrls.operations });
    const repository = new PostgresChannelPairingRepository(pool);

    try {
      await seedHousehold(pool);

      const pending = await repository.upsertPendingRequest({
        channel: 'telegram',
        externalUserId: '1234567890123',
        externalChatId: '9876543210987',
        codeHash: 'a'.repeat(64),
        codeSalt: 'b'.repeat(32),
        displayName: 'Ada Lovelace',
        username: 'ada',
        expiresAt: '2026-07-01T01:00:00.000Z',
        lastSentAt: '2026-07-01T00:00:00.000Z',
        metadata: { messageId: '42' },
      });
      expect(pending).toMatchObject({
        channel: 'telegram',
        externalUserId: '1234567890123',
        externalChatId: '9876543210987',
        codeHash: 'a'.repeat(64),
        codeSalt: 'b'.repeat(32),
      });

      await expect(repository.listPendingRequests({
        channel: 'telegram',
        now: '2026-07-01T00:10:00.000Z',
      })).resolves.toHaveLength(1);

      const approved = await repository.consumePendingAndApprove({
        pendingRequestId: pending.id,
        householdId,
        approvedBy: 'cli:test',
        approvedAt: '2026-07-01T00:15:00.000Z',
      });
      expect(approved).toMatchObject({
        channel: 'telegram',
        externalUserId: '1234567890123',
        externalChatId: '9876543210987',
        householdId,
        displayName: 'Ada Lovelace',
        username: 'ada',
      });

      await expect(repository.findActivePrincipal({
        channel: 'telegram',
        externalUserId: '1234567890123',
      })).resolves.toMatchObject({ householdId });

      await repository.revokePrincipal({
        channel: 'telegram',
        externalUserId: '1234567890123',
        revokedAt: '2026-07-01T00:20:00.000Z',
      });

      await expect(repository.findActivePrincipal({
        channel: 'telegram',
        externalUserId: '1234567890123',
      })).resolves.toBeUndefined();
    } finally {
      await pool.end();
    }
  });

  it('records failed approval attempts and lockout timestamps', async () => {
    context = await createPostgresTestContext('channel_pairing_failed_attempts');
    const pool = new Pool({ connectionString: context.roleUrls.operations });
    const repository = new PostgresChannelPairingRepository(pool);

    try {
      await repository.upsertPendingRequest({
        channel: 'telegram',
        externalUserId: '1234567890123',
        externalChatId: '9876543210987',
        codeHash: 'a'.repeat(64),
        codeSalt: 'b'.repeat(32),
        displayName: 'Ada Lovelace',
        username: 'ada',
        expiresAt: '2026-07-01T01:00:00.000Z',
        lastSentAt: '2026-07-01T00:00:00.000Z',
        metadata: {},
      });

      const [pending] = await repository.listPendingRequests({
        channel: 'telegram',
        now: '2026-07-01T00:10:00.000Z',
      });
      expect(pending).toBeDefined();

      const failed = await repository.recordFailedApprovalAttempt({
        pendingRequestId: pending!.id,
        lockUntil: '2026-07-01T01:10:00.000Z',
      });

      expect(failed.failedApprovalAttemptCount).toBe(1);
      expect(failed.approvalLockedUntil).toBe('2026-07-01T01:10:00.000Z');
    } finally {
      await pool.end();
    }
  });
});
