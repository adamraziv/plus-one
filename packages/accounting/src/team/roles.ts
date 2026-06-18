import type { Agent } from '@mastra/core/agent';
import type { AgentRegistry, AgentRoleDefinition } from '@plus-one/runtime';

const role = (roleName: string, kind: 'lead' | 'maker' | 'checker', agentId: string,
  policyName: string): AgentRoleDefinition => ({
  identity: { roleName, roleVersion: 1 },
  kind,
  agentId,
  runtimePolicy: { policyName, policyVersion: 1 },
});

export const accountingRoles = [
  role('accounting-lead', 'lead', 'accounting-lead', 'accounting-lead'),
  role('transaction-capture-maker', 'maker', 'transaction-capture-maker', 'accounting-maker'),
  role('transaction-capture-checker', 'checker', 'transaction-capture-checker', 'accounting-checker'),
  role('journal-maker', 'maker', 'journal-maker', 'accounting-maker'),
  role('journal-checker', 'checker', 'journal-checker', 'accounting-checker'),
  role('chart-maker', 'maker', 'chart-maker', 'accounting-maker'),
  role('chart-checker', 'checker', 'chart-checker', 'accounting-checker'),
] as const;

export const accountingToolPermissions = accountingRoles.map((entry) => ({
  team: 'accounting',
  roleName: entry.identity.roleName,
  roleVersion: entry.identity.roleVersion,
  toolIds: [] as const,
}));

export function registerAccountingAgents(registry: AgentRegistry, input: {
  models: { lead: string; maker: string; checker: string };
  agents: Record<string, Agent>;
}): void {
  for (const entry of accountingRoles) {
    const agent = input.agents[entry.agentId];
    if (agent === undefined) throw new TypeError('Missing accounting agent ' + entry.agentId);
    registry.register({
      agentId: entry.agentId,
      modelId: input.models[entry.kind],
      roleKind: entry.kind,
      memoryEnabled: false,
      agent,
    });
  }
}
