import type { AgentRegistration, AgentRegistry, AgentRoleDefinition } from '@plus-one/runtime';

const role = (roleName: string, kind: 'maker' | 'checker', skillName: string): AgentRoleDefinition & {
  skillName: string;
} => ({
  identity: { roleName, roleVersion: 1 },
  kind,
  agentId: roleName,
  runtimePolicy: { policyName: `${roleName}-policy`, policyVersion: 1 },
  skillName,
});

export const ingestionRoles = [
  role('ingestion-maker', 'maker', 'accounting-ingestion'),
  role('ingestion-checker', 'checker', 'accounting-ingestion-check'),
  role('reconciliation-maker', 'maker', 'accounting-reconciliation'),
  role('reconciliation-checker', 'checker', 'accounting-reconciliation-check'),
] as const;

export const ingestionToolPermissions = ingestionRoles.map((entry) => ({
  team: 'accounting',
  roleName: entry.identity.roleName,
  roleVersion: entry.identity.roleVersion,
  toolIds: [] as const,
}));

export function registerIngestionAgents(registry: AgentRegistry, input: {
  models: { maker: string; checker: string };
  agents: Record<string, AgentRegistration['agent']>;
}): void {
  for (const entry of ingestionRoles) {
    const agent = input.agents[entry.agentId];
    if (agent === undefined) throw new TypeError('Missing ingestion agent ' + entry.agentId);
    registry.register({
      agentId: entry.agentId,
      modelId: entry.kind === 'maker' ? input.models.maker : input.models.checker,
      roleKind: entry.kind,
      memoryEnabled: false,
      agent,
    });
  }
}
