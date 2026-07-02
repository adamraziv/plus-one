import type { TelegramPairingService } from '@plus-one/runtime';

export async function handleTelegramPairingCommand(input: {
  argv: string[];
  service: Pick<TelegramPairingService, 'approveCode' | 'revoke' | 'listPending'>;
  approvedBy: string;
}): Promise<string> {
  const [command, value, flag, householdId] = input.argv;
  if (command === 'approve') {
    if (value === undefined || flag !== '--household' || householdId === undefined) {
      throw new Error('Usage: plus-one telegram pairing approve <code> --household <household_id>');
    }
    const result = await input.service.approveCode({
      code: value,
      householdId,
      approvedBy: input.approvedBy,
    });
    if (result.status === 'approved') {
      return `Approved Telegram user ${result.principal.externalUserId} for household ${result.principal.householdId}.`;
    }
    if (result.status === 'locked') {
      return `Pairing approval is locked until ${result.lockedUntil}.`;
    }
    return 'Pairing code was invalid or expired.';
  }
  if (command === 'revoke') {
    if (value === undefined) throw new Error('Usage: plus-one telegram pairing revoke <telegram_user_id>');
    await input.service.revoke({ externalUserId: value });
    return `Revoked Telegram user ${value}.`;
  }
  if (command === 'list-pending') {
    const pending = await input.service.listPending();
    if (pending.length === 0) return 'No pending Telegram pairing requests.';
    return pending.map((request) => [
      request.channel,
      request.externalUserId,
      request.displayName ?? request.username ?? '',
      `expires ${request.expiresAt}`,
      `code-hash ${request.codeHash.slice(0, 8)}`,
    ].filter((part) => part.length > 0).join(' ')).join('\n');
  }
  throw new Error('Usage: plus-one telegram pairing approve <code> --household <household_id> | revoke <telegram_user_id> | list-pending');
}
