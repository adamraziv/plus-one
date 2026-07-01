import { describe, expect, it, vi } from 'vitest';
import { handleTelegramPairingCommand } from '../src/telegram/pairing-cli.js';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';

describe('telegram pairing CLI command handler', () => {
  it('approves a code for a household', async () => {
    const service = {
      approveCode: vi.fn(async () => ({
        status: 'approved' as const,
        principal: {
          id: 'principal-1',
          channel: 'telegram' as const,
          externalUserId: '1234567890123',
          externalChatId: '9876543210987',
          householdId,
          approvedAt: '2026-07-01T00:00:00.000Z',
          approvedBy: 'cli:test',
          metadata: {},
        },
      })),
      revoke: vi.fn(),
      listPending: vi.fn(),
    };

    await expect(handleTelegramPairingCommand({
      argv: ['approve', 'ABCDEFGH', '--household', householdId],
      service,
      approvedBy: 'cli:test',
    })).resolves.toEqual(
      'Approved Telegram user 1234567890123 for household hh_01JNZQ4A9B8C7D6E5F4G3H2J1K.',
    );
  });

  it('revokes a Telegram user id', async () => {
    const service = {
      approveCode: vi.fn(),
      revoke: vi.fn(async () => undefined),
      listPending: vi.fn(),
    };

    await expect(handleTelegramPairingCommand({
      argv: ['revoke', '1234567890123'],
      service,
      approvedBy: 'cli:test',
    })).resolves.toEqual('Revoked Telegram user 1234567890123.');
    expect(service.revoke).toHaveBeenCalledWith({ externalUserId: '1234567890123' });
  });

  it('lists pending Telegram pairing requests without revealing raw codes', async () => {
    const service = {
      approveCode: vi.fn(),
      revoke: vi.fn(),
      listPending: vi.fn(async () => [{
        id: '1',
        channel: 'telegram' as const,
        externalUserId: '1234567890123',
        externalChatId: '9876543210987',
        codeHash: 'abcdef1234567890'.padEnd(64, '0'),
        codeSalt: 'b'.repeat(32),
        displayName: 'Ada Lovelace',
        username: 'ada',
        expiresAt: '2026-07-01T01:00:00.000Z',
        lastSentAt: '2026-07-01T00:00:00.000Z',
        failedApprovalAttemptCount: 0,
        metadata: {},
      }]),
    };

    await expect(handleTelegramPairingCommand({
      argv: ['list-pending'],
      service,
      approvedBy: 'cli:test',
    })).resolves.toEqual(
      'telegram 1234567890123 Ada Lovelace expires 2026-07-01T01:00:00.000Z code-hash abcdef12',
    );
  });
});
