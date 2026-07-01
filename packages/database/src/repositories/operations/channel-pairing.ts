import { HouseholdIdSchema, PlusOneError } from '@plus-one/contracts';
import type { Pool } from 'pg';

export type PairableChannel = 'telegram' | 'slack';

export interface ChannelPrincipalRecord {
  id: string;
  channel: PairableChannel;
  externalUserId: string;
  externalChatId: string;
  householdId: string;
  displayName?: string;
  username?: string;
  approvedAt: string;
  approvedBy: string;
  revokedAt?: string;
  metadata: Record<string, unknown>;
}

export interface PendingChannelPairingRecord {
  id: string;
  channel: PairableChannel;
  externalUserId: string;
  externalChatId: string;
  codeHash: string;
  codeSalt: string;
  displayName?: string;
  username?: string;
  expiresAt: string;
  consumedAt?: string;
  lastSentAt: string;
  failedApprovalAttemptCount: number;
  approvalLockedUntil?: string;
  metadata: Record<string, unknown>;
}

interface PrincipalRow {
  id: string;
  channel: PairableChannel;
  external_user_id: string;
  external_chat_id: string;
  household_id: string;
  display_name: string | null;
  username: string | null;
  approved_at: Date;
  approved_by: string;
  revoked_at: Date | null;
  metadata: Record<string, unknown>;
}

interface PendingRow {
  id: string;
  channel: PairableChannel;
  external_user_id: string;
  external_chat_id: string;
  code_hash: string;
  code_salt: string;
  display_name: string | null;
  username: string | null;
  expires_at: Date;
  consumed_at: Date | null;
  last_sent_at: Date;
  failed_approval_attempt_count: number;
  approval_locked_until: Date | null;
  metadata: Record<string, unknown>;
}

function principal(row: PrincipalRow): ChannelPrincipalRecord {
  return {
    id: row.id,
    channel: row.channel,
    externalUserId: row.external_user_id,
    externalChatId: row.external_chat_id,
    householdId: row.household_id,
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    ...(row.username === null ? {} : { username: row.username }),
    approvedAt: row.approved_at.toISOString(),
    approvedBy: row.approved_by,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at.toISOString() }),
    metadata: row.metadata,
  };
}

function pending(row: PendingRow): PendingChannelPairingRecord {
  return {
    id: row.id,
    channel: row.channel,
    externalUserId: row.external_user_id,
    externalChatId: row.external_chat_id,
    codeHash: row.code_hash,
    codeSalt: row.code_salt,
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    ...(row.username === null ? {} : { username: row.username }),
    expiresAt: row.expires_at.toISOString(),
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at.toISOString() }),
    lastSentAt: row.last_sent_at.toISOString(),
    failedApprovalAttemptCount: row.failed_approval_attempt_count,
    ...(row.approval_locked_until === null ? {} : {
      approvalLockedUntil: row.approval_locked_until.toISOString(),
    }),
    metadata: row.metadata,
  };
}

export class PostgresChannelPairingRepository {
  constructor(private readonly pool: Pool) {}

  async findActivePrincipal(input: {
    channel: PairableChannel;
    externalUserId: string;
  }): Promise<ChannelPrincipalRecord | undefined> {
    const result = await this.pool.query<PrincipalRow>(
      `SELECT principal.id::text, principal.channel, principal.external_user_id,
              principal.external_chat_id, household.household_id, principal.display_name,
              principal.username, principal.approved_at, principal.approved_by,
              principal.revoked_at, principal.metadata
       FROM operations.channel_principals principal
       JOIN operations.households household ON household.id = principal.household_id
       WHERE principal.channel = $1
         AND principal.external_user_id = $2
         AND principal.revoked_at IS NULL`,
      [input.channel, input.externalUserId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : principal(row);
  }

  async upsertPendingRequest(input: {
    channel: PairableChannel;
    externalUserId: string;
    externalChatId: string;
    codeHash: string;
    codeSalt: string;
    displayName?: string;
    username?: string;
    expiresAt: string;
    lastSentAt: string;
    metadata: Record<string, unknown>;
  }): Promise<PendingChannelPairingRecord> {
    const result = await this.pool.query<PendingRow>(
      `INSERT INTO operations.channel_pairing_requests
       (channel, external_user_id, external_chat_id, code_hash, code_salt,
        display_name, username, expires_at, last_sent_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10)
       ON CONFLICT (channel, external_user_id) WHERE consumed_at IS NULL
       DO UPDATE SET external_chat_id = EXCLUDED.external_chat_id,
                     code_hash = EXCLUDED.code_hash,
                     code_salt = EXCLUDED.code_salt,
                     display_name = EXCLUDED.display_name,
                     username = EXCLUDED.username,
                     expires_at = EXCLUDED.expires_at,
                     last_sent_at = EXCLUDED.last_sent_at,
                     failed_approval_attempt_count = 0,
                     approval_locked_until = NULL,
                     metadata = EXCLUDED.metadata,
                     updated_at = clock_timestamp()
       RETURNING id::text, channel, external_user_id, external_chat_id, code_hash, code_salt,
                 display_name, username, expires_at, consumed_at, last_sent_at,
                 failed_approval_attempt_count, approval_locked_until, metadata`,
      [
        input.channel,
        input.externalUserId,
        input.externalChatId,
        input.codeHash,
        input.codeSalt,
        input.displayName ?? null,
        input.username ?? null,
        input.expiresAt,
        input.lastSentAt,
        JSON.stringify(input.metadata),
      ],
    );
    return pending(result.rows[0]!);
  }

  async listPendingRequests(input: {
    channel: PairableChannel;
    now: string;
  }): Promise<PendingChannelPairingRecord[]> {
    const result = await this.pool.query<PendingRow>(
      `SELECT id::text, channel, external_user_id, external_chat_id, code_hash, code_salt,
              display_name, username, expires_at, consumed_at, last_sent_at,
              failed_approval_attempt_count, approval_locked_until, metadata
       FROM operations.channel_pairing_requests
       WHERE channel = $1
         AND consumed_at IS NULL
         AND expires_at > $2::timestamptz
       ORDER BY created_at`,
      [input.channel, input.now],
    );
    return result.rows.map(pending);
  }

  async consumePendingAndApprove(input: {
    pendingRequestId: string;
    householdId: string;
    approvedBy: string;
    approvedAt: string;
  }): Promise<ChannelPrincipalRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const consumed = await client.query<PendingRow>(
        `UPDATE operations.channel_pairing_requests
         SET consumed_at = $2::timestamptz,
             updated_at = clock_timestamp()
         WHERE id = $1::bigint
           AND consumed_at IS NULL
         RETURNING id::text, channel, external_user_id, external_chat_id, code_hash, code_salt,
                   display_name, username, expires_at, consumed_at, last_sent_at,
                   failed_approval_attempt_count, approval_locked_until, metadata`,
        [input.pendingRequestId, input.approvedAt],
      );
      const pendingRow = consumed.rows[0];
      if (pendingRow === undefined) throw this.notFound('pending_pairing_not_found', input.pendingRequestId);

      const inserted = await client.query<PrincipalRow>(
        `INSERT INTO operations.channel_principals
         (channel, external_user_id, external_chat_id, household_id, display_name, username,
          approved_at, approved_by, metadata)
         SELECT $1, $2, $3, household.id, $4, $5, $6::timestamptz, $7, $8
         FROM operations.households household
         WHERE household.household_id = $9
         ON CONFLICT (channel, external_user_id) WHERE revoked_at IS NULL
         DO UPDATE SET external_chat_id = EXCLUDED.external_chat_id,
                       household_id = EXCLUDED.household_id,
                       display_name = EXCLUDED.display_name,
                       username = EXCLUDED.username,
                       approved_at = EXCLUDED.approved_at,
                       approved_by = EXCLUDED.approved_by,
                       metadata = EXCLUDED.metadata,
                       updated_at = clock_timestamp()
         RETURNING id::text, channel, external_user_id, external_chat_id,
                   $9 AS household_id, display_name, username, approved_at,
                   approved_by, revoked_at, metadata`,
        [
          pendingRow.channel,
          pendingRow.external_user_id,
          pendingRow.external_chat_id,
          pendingRow.display_name,
          pendingRow.username,
          input.approvedAt,
          input.approvedBy,
          JSON.stringify(pendingRow.metadata),
          HouseholdIdSchema.parse(input.householdId),
        ],
      );
      if (inserted.rows[0] === undefined) throw this.notFound('household_not_found', input.householdId);

      await client.query('COMMIT');
      return principal(inserted.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async recordFailedApprovalAttempt(input: {
    pendingRequestId: string;
    lockUntil?: string;
  }): Promise<PendingChannelPairingRecord> {
    const result = await this.pool.query<PendingRow>(
      `UPDATE operations.channel_pairing_requests
       SET failed_approval_attempt_count = failed_approval_attempt_count + 1,
           approval_locked_until = COALESCE($2::timestamptz, approval_locked_until),
           updated_at = clock_timestamp()
       WHERE id = $1::bigint
       RETURNING id::text, channel, external_user_id, external_chat_id, code_hash, code_salt,
                 display_name, username, expires_at, consumed_at, last_sent_at,
                 failed_approval_attempt_count, approval_locked_until, metadata`,
      [input.pendingRequestId, input.lockUntil ?? null],
    );
    if (result.rows[0] === undefined) throw this.notFound('pending_pairing_not_found', input.pendingRequestId);
    return pending(result.rows[0]);
  }

  async revokePrincipal(input: {
    channel: PairableChannel;
    externalUserId: string;
    revokedAt: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE operations.channel_principals
       SET revoked_at = $3::timestamptz,
           updated_at = clock_timestamp()
       WHERE channel = $1
         AND external_user_id = $2
         AND revoked_at IS NULL`,
      [input.channel, input.externalUserId, input.revokedAt],
    );
  }

  private notFound(code: string, id: string): PlusOneError {
    return new PlusOneError({
      category: 'validation_rejected',
      code,
      message: 'Channel pairing record was not found',
      retry: 'never',
      receiptLookupRequired: false,
      details: { id },
    });
  }
}
