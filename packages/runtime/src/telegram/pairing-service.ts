import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

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

export interface ChannelPairingRepositoryPort {
  findActivePrincipal(input: {
    channel: PairableChannel;
    externalUserId: string;
  }): Promise<ChannelPrincipalRecord | undefined>;
  upsertPendingRequest(input: {
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
  }): Promise<PendingChannelPairingRecord>;
  listPendingRequests(input: {
    channel: PairableChannel;
    now: string;
  }): Promise<PendingChannelPairingRecord[]>;
  consumePendingAndApprove(input: {
    pendingRequestId: string;
    householdId: string;
    approvedBy: string;
    approvedAt: string;
  }): Promise<ChannelPrincipalRecord>;
  recordFailedApprovalAttempt(input: {
    pendingRequestId: string;
    lockUntil?: string;
  }): Promise<PendingChannelPairingRecord>;
  revokePrincipal(input: {
    channel: PairableChannel;
    externalUserId: string;
    revokedAt: string;
  }): Promise<void>;
}

export type PairingRequestResult =
  | { status: 'created'; code: string; expiresAt: string }
  | { status: 'rate-limited'; retryAfter: string }
  | { status: 'too-many-pending' };

export type PairingApprovalResult =
  | { status: 'approved'; principal: ChannelPrincipalRecord }
  | { status: 'invalid-code' }
  | { status: 'locked'; lockedUntil: string };

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_TTL_MS = 60 * 60 * 1000;
const RATE_LIMIT_MS = 10 * 60 * 1000;
const LOCKOUT_MS = 60 * 60 * 1000;
const MAX_PENDING = 3;
const MAX_FAILED_ATTEMPTS = 5;

export class TelegramPairingService {
  constructor(private readonly dependencies: {
    repository: ChannelPairingRepositoryPort;
    codeGenerator?: () => string;
    saltGenerator?: () => string;
    now?: () => Date;
  }) {}

  async findPrincipal(externalUserId: string): Promise<ChannelPrincipalRecord | undefined> {
    return this.dependencies.repository.findActivePrincipal({
      channel: 'telegram',
      externalUserId,
    });
  }

  async createPairingRequest(input: {
    externalUserId: string;
    externalChatId: string;
    displayName?: string;
    username?: string;
    metadata: Record<string, unknown>;
  }): Promise<PairingRequestResult> {
    const now = this.now();
    const pending = await this.dependencies.repository.listPendingRequests({
      channel: 'telegram',
      now: now.toISOString(),
    });
    const existing = pending.find((request) => request.externalUserId === input.externalUserId);
    if (existing !== undefined) {
      const retryAfter = new Date(new Date(existing.lastSentAt).getTime() + RATE_LIMIT_MS);
      if (retryAfter > now) return { status: 'rate-limited', retryAfter: retryAfter.toISOString() };
    }
    if (pending.length >= MAX_PENDING && existing === undefined) return { status: 'too-many-pending' };

    const code = (this.dependencies.codeGenerator ?? generateCode)();
    const salt = (this.dependencies.saltGenerator ?? generateSalt)();
    const expiresAt = new Date(now.getTime() + CODE_TTL_MS).toISOString();
    await this.dependencies.repository.upsertPendingRequest({
      channel: 'telegram',
      externalUserId: input.externalUserId,
      externalChatId: input.externalChatId,
      codeHash: hashCode(code, salt),
      codeSalt: salt,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(input.username === undefined ? {} : { username: input.username }),
      expiresAt,
      lastSentAt: now.toISOString(),
      metadata: input.metadata,
    });
    return { status: 'created', code, expiresAt };
  }

  async approveCode(input: {
    code: string;
    householdId: string;
    approvedBy: string;
  }): Promise<PairingApprovalResult> {
    const now = this.now();
    const pending = await this.dependencies.repository.listPendingRequests({
      channel: 'telegram',
      now: now.toISOString(),
    });

    for (const request of pending) {
      if (constantTimeEqual(hashCode(input.code, request.codeSalt), request.codeHash)) {
        if (request.approvalLockedUntil !== undefined && new Date(request.approvalLockedUntil) > now) {
          return { status: 'locked', lockedUntil: request.approvalLockedUntil };
        }
        const principal = await this.dependencies.repository.consumePendingAndApprove({
          pendingRequestId: request.id,
          householdId: input.householdId,
          approvedBy: input.approvedBy,
          approvedAt: now.toISOString(),
        });
        return { status: 'approved', principal };
      }
    }

    const first = pending.find((request) => !isApprovalLocked(request, now));
    if (first !== undefined) {
      const failedCount = first.failedApprovalAttemptCount + 1;
      const lockUntil = failedCount >= MAX_FAILED_ATTEMPTS
        ? new Date(now.getTime() + LOCKOUT_MS).toISOString()
        : undefined;
      await this.dependencies.repository.recordFailedApprovalAttempt({
        pendingRequestId: first.id,
        ...(lockUntil === undefined ? {} : { lockUntil }),
      });
      if (lockUntil !== undefined) return { status: 'locked', lockedUntil: lockUntil };
    }

    const locked = pending.find((request) => isApprovalLocked(request, now));
    if (locked?.approvalLockedUntil !== undefined) {
      return { status: 'locked', lockedUntil: locked.approvalLockedUntil };
    }

    return { status: 'invalid-code' };
  }

  async revoke(input: { externalUserId: string }): Promise<void> {
    await this.dependencies.repository.revokePrincipal({
      channel: 'telegram',
      externalUserId: input.externalUserId,
      revokedAt: this.now().toISOString(),
    });
  }

  async listPending(): Promise<PendingChannelPairingRecord[]> {
    return this.dependencies.repository.listPendingRequests({
      channel: 'telegram',
      now: this.now().toISOString(),
    });
  }

  private now(): Date {
    return (this.dependencies.now ?? (() => new Date()))();
  }
}

function generateCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length] ?? 'A').join('');
}

function generateSalt(): string {
  return randomBytes(16).toString('hex');
}

function hashCode(code: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${code.trim().toUpperCase()}`).digest('hex');
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isApprovalLocked(request: PendingChannelPairingRecord, now: Date): boolean {
  return request.approvalLockedUntil !== undefined && new Date(request.approvalLockedUntil) > now;
}
