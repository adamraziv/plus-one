import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CommandRegistry } from './command-registry.js';

const handler = {
  commandType: 'test_command',
  domainRole: 'accounting' as const,
  inputSchema: z.object({ amount: z.string() }).strict(),
  inputSchemaIdentity: { schemaName: 'test-command-input', schemaVersion: 1 },
  confirmation: 'required' as const,
  requiredReadbackChecks: [
    'identifiers',
    'row_values',
    'artifact_links',
    'idempotency_receipt',
  ] as const,
  execute: vi.fn(),
  readback: vi.fn(),
};

describe('CommandRegistry', () => {
  it('resolves one allowlisted handler and independently parses its payload', () => {
    const registry = new CommandRegistry([handler]);
    const prepared = registry.prepare({
      commandType: 'test_command',
      payloadSchema: { schemaName: 'test-command-input', schemaVersion: 1 },
      payload: { amount: '20.00' },
      confirmationId: 'confirm_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    });
    expect(prepared.input).toEqual({ amount: '20.00' });
    expect(prepared.handler).toBe(handler);
  });

  it('rejects unknown, duplicate, schema-drifted, and unconfirmed commands', () => {
    expect(() => new CommandRegistry([handler, handler])).toThrow(/Duplicate command type/);
    const registry = new CommandRegistry([handler]);
    expect(() => registry.prepare({
      commandType: 'unknown',
      payloadSchema: handler.inputSchemaIdentity,
      payload: {},
    })).toThrow(/not allowlisted/);
    expect(() => registry.prepare({
      commandType: 'test_command',
      payloadSchema: { schemaName: 'test-command-input', schemaVersion: 2 },
      payload: { amount: '20.00' },
      confirmationId: 'confirm_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    })).toThrow(/schema identity/);
    expect(() => registry.prepare({
      commandType: 'test_command',
      payloadSchema: handler.inputSchemaIdentity,
      payload: { amount: '20.00' },
    })).toThrow(/confirmation/);
  });
});
