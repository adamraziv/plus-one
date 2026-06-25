import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { createAgentSystem } from '../src/agent-catalog.js';

const models = {
  lead: { id: 'provider/lead', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
  maker: { id: 'provider/maker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
  checker: { id: 'provider/checker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
  research: { id: 'provider/research', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
};

describe('engine agent catalog', () => {
  it('registers every in-scope team role and keeps checkers memory-disabled', () => {
    const genericCreated: string[] = [];
    const queryCreated: string[] = [];
    const accountingCreated: string[] = [];
    const system = createAgentSystem({
      models,
      agentFactory: ({ agentId }) => {
        genericCreated.push(agentId);
        return { generate: vi.fn() } as unknown as Agent;
      },
      queryAgentFactory: (config) => {
        queryCreated.push(String(config.id));
        return { generate: vi.fn() } as unknown as Agent;
      },
      accountingAgentFactory: (config) => {
        accountingCreated.push(String(config.id));
        return { generate: vi.fn() } as unknown as Agent;
      },
      queryTools: {},
    });

    const uniqueRoleIds = new Set(system.teams.flatMap((team) => [
      team.lead,
      ...team.workCells.flatMap((cell) => [cell.maker, cell.checker]),
    ]).map((role) => role.agentId));
    expect(new Set([...genericCreated, ...queryCreated, ...accountingCreated]).size).toBe(uniqueRoleIds.size);
    expect(queryCreated.sort()).toEqual([
      'analyst-checker',
      'analyst-maker',
      'query-checker',
      'query-lead',
      'query-maker',
    ]);
    expect(accountingCreated.sort()).toEqual([
      'accounting-lead',
      'chart-checker',
      'chart-maker',
      'ingestion-checker',
      'ingestion-maker',
      'journal-checker',
      'journal-maker',
      'reconciliation-checker',
      'reconciliation-maker',
      'transaction-capture-checker',
      'transaction-capture-maker',
    ]);
    expect(genericCreated).not.toEqual(expect.arrayContaining(accountingCreated));
    expect(system.teams.map((team) => team.team).sort()).toEqual([
      'accounting',
      'budgeting',
      'cash-flow',
      'investments-retirement',
      'query',
      'records-reporting',
    ]);

    for (const team of system.teams) {
      for (const cell of team.workCells) {
        const registration = system.agents.resolve(
          cell.checker.agentId,
          'provider/checker',
          'checker',
        );
        expect(registration.memoryEnabled).toBe(false);
      }
    }
  });

  it('preserves Query as the only team with financial read tools', () => {
    const system = createAgentSystem({
      models,
      agentFactory: () => ({ generate: vi.fn() } as unknown as Agent),
      queryTools: {},
    });

    expect(system.tools.resolve({ team: 'query', roleName: 'query-maker', roleVersion: 1 }))
      .toEqual(expect.arrayContaining(['query_account_list']));
    expect(system.tools.resolve({ team: 'accounting', roleName: 'journal-maker', roleVersion: 1 }))
      .toEqual([]);
    expect(system.tools.resolve({ team: 'budgeting', roleName: 'budget-maker', roleVersion: 1 }))
      .toEqual([]);
    expect(system.tools.resolve({ team: 'records-reporting', roleName: 'records-maker', roleVersion: 1 }))
      .toEqual([]);
  });

  it('includes a configured orchestrator in the Mastra agent map', () => {
    const orchestratorAgent = { generate: vi.fn() } as unknown as Agent;
    const system = createAgentSystem({
      models,
      agentFactory: () => ({ generate: vi.fn() } as unknown as Agent),
      queryTools: {},
      orchestratorAgent,
    });

    expect(system.mastraAgents.orchestrator).toBe(orchestratorAgent);
  });
});
