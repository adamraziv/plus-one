import { describe, expect, it } from 'vitest';
import {
  CheckedCommandSchemaV1,
  ExternalConfirmationSchemaV1,
  MutationReceiptSchemaV1,
  ReadbackResultSchemaV1,
} from './index.js';

const identity = {
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  checkedProposalId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  checkedProposalHash: 'af9711ed6d293d74cdde5580208111b2020a4cf4543b2412c1c150213ec8659f',
};

describe('checked mutation contracts', () => {
  it('accepts an opaque confirmation bound to one exact checked artifact', () => {
    expect(ExternalConfirmationSchemaV1.parse({
      schemaName: 'external-confirmation',
      schemaVersion: 1,
      confirmationId: 'confirm_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      ...identity,
      principalId: 'principal:opaque:7f9b',
      channel: 'telegram',
      channelReference: 'telegram-message:12345',
      confirmedAt: '2026-06-15T08:00:00.000Z',
    }).principalId).toBe('principal:opaque:7f9b');
  });

  it('rejects prompted JSON, unversioned payload schemas, and malformed idempotency keys', () => {
    expect(CheckedCommandSchemaV1.safeParse('{"commandType":"post_accounting_journal"}').success)
      .toBe(false);
    expect(CheckedCommandSchemaV1.safeParse({
      schemaName: 'checked-command',
      schemaVersion: 1,
      commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      ...identity,
      commandType: 'post_accounting_journal',
      idempotencyKey: 'short',
      payloadSchema: { schemaName: '', schemaVersion: 0 },
      payload: {},
    }).success).toBe(false);
  });

  it('requires receipts to preserve command and idempotency identity', () => {
    expect(MutationReceiptSchemaV1.parse({
      schemaName: 'mutation-receipt',
      schemaVersion: 1,
      receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      ...identity,
      commandType: 'post_accounting_journal',
      idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      committedRecords: [{
        recordType: 'accounting.journal',
        recordId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      }],
      expectedState: { journalId: 'journal_01JNZQ4A9B8C7D6E5F4G3H2J1K' },
      expectedStateHash: 'b'.repeat(64),
      committedAt: '2026-06-15T08:00:01.000Z',
    }).committedRecords).toHaveLength(1);
  });

  it('requires unique read-back check kinds and mismatch consistency', () => {
    const duplicate = ReadbackResultSchemaV1.safeParse({
      schemaName: 'mutation-readback',
      schemaVersion: 1,
      readbackId: 'readback_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      ok: true,
      checks: [
        { kind: 'identifiers', status: 'passed' },
        { kind: 'identifiers', status: 'passed' },
      ],
      mismatches: [],
      observedStateHash: 'c'.repeat(64),
    });
    expect(duplicate.success).toBe(false);
    expect(ReadbackResultSchemaV1.safeParse({
      schemaName: 'mutation-readback',
      schemaVersion: 1,
      readbackId: 'readback_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      receiptId: 'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      ok: true,
      checks: [{ kind: 'row_values', status: 'failed', detailCode: 'value_mismatch' }],
      mismatches: ['row_values'],
      observedStateHash: 'c'.repeat(64),
    }).success).toBe(false);
  });
});
