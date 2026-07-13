import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { TeamDefinition } from '@plus-one/runtime';
import { createDelegateTeamTool } from '../src/tools/delegate-team.js';
import { DelegateTeamToolInputSchema } from '../src/tools/delegate-team-schemas.js';

describe('createDelegateTeamTool', () => {
  it('describes the registered team catalog from authoritative ids and charters', () => {
    const query = team('query', 'Answer household finance reads from checked evidence.');
    const accounting = team('accounting', 'Prepare checked household ledger mutations.');
    const tool = createDelegateTeamTool({
      teams: new Map([[query.team, query], [accounting.team, accounting]]),
      teamRuntime: { runTeamLead: vi.fn() },
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
