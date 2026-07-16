import { describe, expect, it } from 'vitest';
import {
  AccountingJournalCommandAdapter, ChartOfAccountsCommandAdapter,
} from './command-adapters.js';

const common = {
  commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
  idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
  taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
  checkedProposalId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
  checkedProposalHash: 'a'.repeat(64),
};

describe('accounting command adapters', () => {
  it('never converts a checked clarification into a mutation command', () => {
    try {
      new AccountingJournalCommandAdapter().buildCommand({
        ...common,
        payloadSchema: { schemaName: 'accounting-work-result', schemaVersion: 1 },
        payload: { schemaName: 'accounting-clarification' as const, schemaVersion: 1 as const,
          missingFields: ['payment_account'] as ['payment_account'],
          questions: ['Which account?'], reason: 'Required.' },
      });
      throw new Error('Expected buildCommand to throw');
    } catch (error) {
      expect(error).toMatchObject({ code: 'accounting_clarification_not_executable' });
    }
  });

  it('allows chart preparation without confirmation and preserves the exact payload object', () => {
    const payload = {
      schemaName: 'chart-of-accounts-proposal' as const, schemaVersion: 1 as const,
      action: 'archive_account' as const,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
    };
    const prepared = new ChartOfAccountsCommandAdapter().buildCommand({
      ...common,
      payloadSchema: { schemaName: 'chart-of-accounts-proposal', schemaVersion: 1 },
      payload,
    });
    expect(prepared.confirmationId).toBeUndefined();
    expect(prepared.payload).toEqual(payload);
    const command = new ChartOfAccountsCommandAdapter().buildCommand({
      ...common,
      confirmationId: 'confirm_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
      payloadSchema: { schemaName: 'chart-of-accounts-proposal', schemaVersion: 1 },
      payload,
    });
    expect(command.payload).toEqual(payload);
  });
});
