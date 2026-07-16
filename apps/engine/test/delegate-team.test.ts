import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { TeamDefinition } from '@plus-one/runtime';
import { createDelegateTeamTool } from '../src/tools/delegate-team.js';
import {
  AccountingDelegateRequestSchemaV1,
  DelegateTeamToolInputSchema,
} from '../src/tools/delegate-team-schemas.js';
import { MaterializedAccountingLeadRequestSchemaV1 } from '../src/accounting/accounting-lead-contracts.js';

describe('createDelegateTeamTool', () => {
  it('describes the registered team catalog from authoritative ids and charters', () => {
    const query = team('query', 'Answer household finance reads from checked evidence.');
    const accounting = team('accounting', 'Prepare checked household ledger mutations.');
    const tool = createDelegateTeamTool({
      teams: new Map([[query.team, query], [accounting.team, accounting]]),
      teamRuntime: {
        runTeamLead: vi.fn(),
        resumePendingMutation: async () => { throw new Error('Unexpected mutation resume'); },
        cancelPendingMutation: async () => { throw new Error('Unexpected mutation cancellation'); },
      },
      getActiveInvocation: () => undefined,
    });

    expect(tool.description).toContain('query: Answer household finance reads from checked evidence.');
    expect(tool.description).toContain('accounting: Prepare checked household ledger mutations.');
    expect(tool.description).not.toContain('Use query for checked finance reads.');
    expect(tool.description).not.toContain('Use accounting for explicit record');
    expect(tool.description).toContain('exact team id');
    expect(tool.description).toContain('Do not use this tool for payments');
  });

  it('exposes team-specific request contracts to the model provider', () => {
    const jsonSchema = z.toJSONSchema(DelegateTeamToolInputSchema);
    const providerSchema = JSON.stringify(jsonSchema);
    const teamSchema = (jsonSchema as { properties?: { team?: unknown } }).properties?.team;

    expect(jsonSchema).toMatchObject({ type: 'object' });
    expect(jsonSchema).not.toHaveProperty('anyOf');
    expect(teamSchema).toMatchObject({
      type: 'string',
      enum: expect.arrayContaining(['query', 'accounting']),
    });
    expect(providerSchema).toContain('"const":"accounting-lead-request"');
    expect(providerSchema).toContain('"const":"transaction-capture-request-draft"');
    expect(providerSchema).toContain('"const":"query-lead-request-draft"');
  });

  it('rejects the malformed accounting shape observed from a generic request schema', () => {
    expect(DelegateTeamToolInputSchema.safeParse({
      team: 'accounting',
      request: {
        intent: 'transaction_capture',
        'transaction-capture-request-draft': {
          known: { amount: 10, paymentAccountName: null },
        },
      },
    }).success).toBe(false);
  });

  it('accepts only declared Accounting drafts or complete work requests', () => {
    expect(() => AccountingDelegateRequestSchemaV1.parse({
      schemaName: 'accounting-lead-request',
      schemaVersion: 1,
      intent: 'chart_of_accounts',
      request: { instruction: 'Add a bank account' },
    })).toThrow();

    expect(AccountingDelegateRequestSchemaV1.parse({
      schemaName: 'accounting-lead-request',
      schemaVersion: 1,
      intent: 'chart_of_accounts',
      request: {
        schemaName: 'chart-work-request-draft',
        schemaVersion: 1,
        action: 'create_account',
        instruction: 'Add a bank account',
        known: {},
      },
    }).intent).toBe('chart_of_accounts');
  });

  it.each([
    ['transaction_capture', {
      schemaName: 'transaction-capture-request-draft', schemaVersion: 1,
      instruction: 'Capture a grocery purchase.', known: {},
    }],
    ['journal', {
      schemaName: 'journal-work-request-draft', schemaVersion: 1,
      operation: 'post', instruction: 'Post a grocery purchase.',
    }],
    ['chart_of_accounts', {
      schemaName: 'chart-work-request-draft', schemaVersion: 1,
      action: 'create_account', instruction: 'Create a checking account.', known: {},
    }],
    ['ingestion', {
      schemaName: 'ingestion-work-request-draft', schemaVersion: 1,
      instruction: 'Import this statement.', sourceReference: {},
    }],
    ['reconciliation', {
      schemaName: 'reconciliation-work-request-draft', schemaVersion: 1,
      instruction: 'Reconcile the checking statement.', accountName: 'Checking',
      statementReference: 'June statement', requestedOperation: 'reconcile',
    }],
  ] as const)('does not accept arbitrary JSON for the %s Accounting intent', (intent, request) => {
    expect(AccountingDelegateRequestSchemaV1.parse({
      schemaName: 'accounting-lead-request', schemaVersion: 1, intent, request,
    }).intent).toBe(intent);
    expect(AccountingDelegateRequestSchemaV1.safeParse({
      schemaName: 'accounting-lead-request', schemaVersion: 1, intent,
      request: { instruction: 'No typed request schema.' },
    }).success).toBe(false);
  });

  it('keeps semantic drafts out of the materialized Accounting contract', () => {
    expect(MaterializedAccountingLeadRequestSchemaV1.safeParse({
      schemaName: 'accounting-lead-request', schemaVersion: 1,
      intent: 'chart_of_accounts',
      request: {
        schemaName: 'chart-work-request-draft', schemaVersion: 1,
        action: 'create_account', instruction: 'Create a checking account.', known: {},
      },
    }).success).toBe(false);
    expect(MaterializedAccountingLeadRequestSchemaV1.safeParse({
      schemaName: 'accounting-lead-request', schemaVersion: 1,
      intent: 'journal',
      request: {
        schemaName: 'journal-work-request', schemaVersion: 1,
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        operation: 'post', instruction: 'Post the entry.',
      },
    }).success).toBe(true);
  });
});

function team(teamId: string, charter: string): TeamDefinition {
  return {
    team: teamId,
    lead: {
      identity: { roleName: `${teamId}-lead`, roleVersion: 1 },
      kind: 'lead',
      agentId: `${teamId}-lead`,
      runtimePolicy: { policyName: `${teamId}-lead`, policyVersion: 1 },
    },
    charter,
    prohibitedBehavior: [],
    workCells: [],
    allowedStrategyNames: ['single-maker-checker'],
  } as TeamDefinition;
}
