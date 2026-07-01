import { describe, expect, it, vi } from 'vitest';
import {
  TelegramPairingService,
  type ChannelPairingRepositoryPort,
  type PendingChannelPairingRecord,
} from './pairing-service.js';

const now = new Date('2026-07-01T00:00:00.000Z');
const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';

function fakeRepository(): ChannelPairingRepositoryPort & {
  pending: PendingChannelPairingRecord[];
} {
  const pending: PendingChannelPairingRecord[] = [];
  return {
    pending,
    async findActivePrincipal() {
      return undefined;
    },
    async upsertPendingRequest(input) {
      const existing = pending.find((candidate) => candidate.externalUserId === input.externalUserId);
      const record: PendingChannelPairingRecord = {
        id: existing?.id ?? String(pending.length + 1),
        channel: input.channel,
        externalUserId: input.externalUserId,
        externalChatId: input.externalChatId,
        codeHash: input.codeHash,
        codeSalt: input.codeSalt,
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.username === undefined ? {} : { username: input.username }),
        expiresAt: input.expiresAt,
        lastSentAt: input.lastSentAt,
        failedApprovalAttemptCount: 0,
        metadata: input.metadata,
      };
      if (existing === undefined) {
        pending.push(record);
      } else {
        pending.splice(pending.indexOf(existing), 1, record);
      }
      return record;
    },
    async listPendingRequests() {
      return pending;
    },
    async consumePendingAndApprove(input) {
      const record = pending.find((candidate) => candidate.id === input.pendingRequestId);
      if (record === undefined) throw new Error('missing pending');
      return {
        id: 'principal-1',
        channel: record.channel,
        externalUserId: record.externalUserId,
        externalChatId: record.externalChatId,
        householdId: input.householdId,
        ...(record.displayName === undefined ? {} : { displayName: record.displayName }),
        ...(record.username === undefined ? {} : { username: record.username }),
        approvedAt: input.approvedAt,
        approvedBy: input.approvedBy,
        metadata: record.metadata,
      };
    },
    async recordFailedApprovalAttempt(input) {
      const record = pending.find((candidate) => candidate.id === input.pendingRequestId);
      if (record === undefined) throw new Error('missing pending');
      const updated: PendingChannelPairingRecord = {
        ...record,
        failedApprovalAttemptCount: record.failedApprovalAttemptCount + 1,
        ...(input.lockUntil === undefined ? {} : { approvalLockedUntil: input.lockUntil }),
      };
      pending.splice(pending.indexOf(record), 1, updated);
      return updated;
    },
    async revokePrincipal() {},
  };
}

function service(repository = fakeRepository()) {
  return new TelegramPairingService({
    repository,
    codeGenerator: () => 'ABCDEFGH',
    saltGenerator: () => 'b'.repeat(32),
    now: () => now,
  });
}

describe('TelegramPairingService', () => {
  it('creates a DM pairing code without storing the raw code', async () => {
    const repository = fakeRepository();
    const result = await service(repository).createPairingRequest({
      externalUserId: '1234567890123',
      externalChatId: '9876543210987',
      displayName: 'Ada Lovelace',
      username: 'ada',
      metadata: { messageId: '42' },
    });

    expect(result).toEqual({
      status: 'created',
      code: 'ABCDEFGH',
      expiresAt: '2026-07-01T01:00:00.000Z',
    });
    expect(repository.pending[0]?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(repository.pending[0])).not.toContain('ABCDEFGH');
  });

  it('approves a matching code for a household', async () => {
    const repository = fakeRepository();
    const pairing = service(repository);

    await pairing.createPairingRequest({
      externalUserId: '1234567890123',
      externalChatId: '9876543210987',
      metadata: {},
    });

    await expect(pairing.approveCode({
      code: 'ABCDEFGH',
      householdId,
      approvedBy: 'cli:test',
    })).resolves.toMatchObject({
      status: 'approved',
      principal: {
        externalUserId: '1234567890123',
        householdId,
      },
    });
  });

  it('rate limits repeated code creation for the same Telegram user', async () => {
    const repository = fakeRepository();
    const pairing = service(repository);

    await pairing.createPairingRequest({
      externalUserId: '1234567890123',
      externalChatId: '9876543210987',
      metadata: {},
    });

    await expect(pairing.createPairingRequest({
      externalUserId: '1234567890123',
      externalChatId: '9876543210987',
      metadata: {},
    })).resolves.toEqual({
      status: 'rate-limited',
      retryAfter: '2026-07-01T00:10:00.000Z',
    });
  });

  it('caps pending pairing requests like Hermes', async () => {
    const repository = fakeRepository();
    const pairing = service(repository);

    for (const externalUserId of ['1', '2', '3']) {
      await pairing.createPairingRequest({
        externalUserId,
        externalChatId: `chat-${externalUserId}`,
        metadata: {},
      });
    }

    await expect(pairing.createPairingRequest({
      externalUserId: '4',
      externalChatId: 'chat-4',
      metadata: {},
    })).resolves.toEqual({ status: 'too-many-pending' });
  });

  it('records failed attempts and locks a request after five misses', async () => {
    const repository = fakeRepository();
    const pairing = service(repository);

    await pairing.createPairingRequest({
      externalUserId: '1234567890123',
      externalChatId: '9876543210987',
      metadata: {},
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(pairing.approveCode({
        code: 'ZZZZZZZZ',
        householdId,
        approvedBy: 'cli:test',
      })).resolves.toEqual({ status: 'invalid-code' });
    }

    await expect(pairing.approveCode({
      code: 'ZZZZZZZZ',
      householdId,
      approvedBy: 'cli:test',
    })).resolves.toEqual({
      status: 'locked',
      lockedUntil: '2026-07-01T01:00:00.000Z',
    });
  });

  it('still approves a valid code when an unrelated pending request is locked', async () => {
    let generatedCode = 'AAAAAAAA';
    const repository = fakeRepository();
    const pairing = new TelegramPairingService({
      repository,
      codeGenerator: () => generatedCode,
      saltGenerator: () => 'b'.repeat(32),
      now: () => now,
    });

    await pairing.createPairingRequest({
      externalUserId: 'user-1',
      externalChatId: 'chat-1',
      metadata: {},
    });
    repository.pending[0] = {
      ...repository.pending[0]!,
      approvalLockedUntil: '2026-07-01T01:00:00.000Z',
    };

    generatedCode = 'BBBBBBBB';
    await pairing.createPairingRequest({
      externalUserId: 'user-2',
      externalChatId: 'chat-2',
      metadata: {},
    });

    await expect(pairing.approveCode({
      code: 'BBBBBBBB',
      householdId,
      approvedBy: 'cli:test',
    })).resolves.toMatchObject({
      status: 'approved',
      principal: {
        externalUserId: 'user-2',
        householdId,
      },
    });
  });

  it('delegates principal lookup and revocation to the repository', async () => {
    const repository = fakeRepository();
    const findActivePrincipal = vi.spyOn(repository, 'findActivePrincipal');
    const revokePrincipal = vi.spyOn(repository, 'revokePrincipal');
    const pairing = service(repository);

    await pairing.findPrincipal('1234567890123');
    await pairing.revoke({ externalUserId: '1234567890123' });

    expect(findActivePrincipal).toHaveBeenCalledWith({
      channel: 'telegram',
      externalUserId: '1234567890123',
    });
    expect(revokePrincipal).toHaveBeenCalledWith({
      channel: 'telegram',
      externalUserId: '1234567890123',
      revokedAt: '2026-07-01T00:00:00.000Z',
    });
  });
});
