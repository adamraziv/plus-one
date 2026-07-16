import { describe, expect, it, vi } from 'vitest';
import { createChartOfAccountsMutationHandler } from './chart-handler.js';

describe('chart mutation handler', () => {
  it('uses typed repository methods and requires confirmation', async () => {
    const repository = {
      createAccount: vi.fn(), updateAccount: vi.fn(), archiveAccount: vi.fn(),
      createAccountSourceMapping: vi.fn(), archiveAccountSourceMapping: vi.fn(),
    };
    const handler = createChartOfAccountsMutationHandler(repository as never);
    expect(handler.confirmation).toBe('required');
    await handler.execute({} as never, {
      schemaName: 'chart-of-accounts-proposal' as const, schemaVersion: 1 as const,
      action: 'create_account' as const,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      name: 'Cash',
      purpose: 'Pocket money',
      ownershipLabel: 'Adam',
      parentAccountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K' as never,
      accountingClass: 'asset' as const,
      normalBalance: 'debit' as const,
      nativeCurrency: 'USD' as never,
    }, { householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      checkedProposalId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      checkedProposalHash: 'a'.repeat(64),
      idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never });
    expect(repository.createAccount).toHaveBeenCalledOnce();
    expect(repository.createAccount).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        purpose: 'Pocket money',
        ownershipLabel: 'Adam',
        parentAccountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
      }),
    );
  });

  it('archives the previous mapping and inserts the new one for replace_source_mapping', async () => {
    const repository = {
      createAccount: vi.fn(), updateAccount: vi.fn(), archiveAccount: vi.fn(),
      createAccountSourceMapping: vi.fn(), archiveAccountSourceMapping: vi.fn(),
    };
    const handler = createChartOfAccountsMutationHandler(repository as never);
    await handler.execute({} as never, {
      schemaName: 'chart-of-accounts-proposal' as const, schemaVersion: 1 as const,
      action: 'replace_source_mapping' as const,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      mappingId: 'accountmap_01JNZQ4A9B8C7D6E5F4G3H2J2K' as never,
      archivedMappingId: 'accountmap_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      sourceSystem: 'bank-feed',
      externalAccountId: 'checking-1',
      metadata: { label: 'Checking' },
    }, { householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      checkedProposalId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      checkedProposalHash: 'a'.repeat(64),
      idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never });
    expect(repository.archiveAccountSourceMapping).toHaveBeenCalledOnce();
    expect(repository.createAccountSourceMapping).toHaveBeenCalledOnce();
  });
});
