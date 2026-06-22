import type {
  AgentRegistry,
  AgentRoleDefinition,
} from '@plus-one/runtime';

const role = (
  roleName: string,
  kind: 'lead' | 'maker' | 'checker',
  agentId: string,
  policyName: string,
): AgentRoleDefinition => ({
  identity: { roleName, roleVersion: 1 },
  kind,
  agentId,
  runtimePolicy: { policyName, policyVersion: 1 },
});

export const planningRoles = [
  role('budgeting-lead', 'lead', 'budgeting-lead', 'planning-lead'),
  role('budget-maker', 'maker', 'budget-maker', 'planning-maker'),
  role('budget-checker', 'checker', 'budget-checker', 'planning-checker'),
  role('budget-scenario-maker', 'maker', 'budget-scenario-maker', 'planning-maker'),
  role('budget-scenario-checker', 'checker', 'budget-scenario-checker', 'planning-checker'),
  role('cash-flow-lead', 'lead', 'cash-flow-lead', 'planning-lead'),
  role('cash-flow-maker', 'maker', 'cash-flow-maker', 'planning-maker'),
  role('cash-flow-checker', 'checker', 'cash-flow-checker', 'planning-checker'),
] as const;

export const planningToolPermissions = planningRoles.map((entry) => ({
  team: entry.agentId.startsWith('budget') ? 'budgeting' : 'cash-flow',
  roleName: entry.identity.roleName,
  roleVersion: entry.identity.roleVersion,
  toolIds: [] as const,
}));

export function registerPlanningAgents(registry: AgentRegistry, input: {
  models: { lead: string; maker: string; checker: string };
  agents: Record<string, unknown>;
}): void {
  for (const entry of planningRoles) {
    const agent = input.agents[entry.agentId];
    if (agent === undefined) throw new TypeError('Missing planning agent ' + entry.agentId);
    registry.register({
      agentId: entry.agentId,
      modelId: input.models[entry.kind],
      roleKind: entry.kind,
      memoryEnabled: false,
      agent: agent as never,
    });
  }
}
