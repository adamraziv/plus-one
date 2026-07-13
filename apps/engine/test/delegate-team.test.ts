import { describe, expect, it, vi } from 'vitest';
import type { TeamDefinition } from '@plus-one/runtime';
import { createDelegateTeamTool } from '../src/tools/delegate-team.js';

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
