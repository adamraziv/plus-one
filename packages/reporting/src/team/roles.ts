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

export const reportingRoles = [
  role('investments-retirement-lead', 'lead', 'investments-retirement-lead', 'reporting-lead'),
  role('investment-education-maker', 'maker', 'investment-education-maker', 'reporting-maker'),
  role('investment-education-checker', 'checker', 'investment-education-checker', 'reporting-checker'),
  role('retirement-education-maker', 'maker', 'retirement-education-maker', 'reporting-maker'),
  role('retirement-education-checker', 'checker', 'retirement-education-checker', 'reporting-checker'),
  role('records-reporting-lead', 'lead', 'records-reporting-lead', 'reporting-lead'),
  role('records-maker', 'maker', 'records-maker', 'reporting-maker'),
  role('records-checker', 'checker', 'records-checker', 'reporting-checker'),
  role('reporting-maker', 'maker', 'reporting-maker', 'reporting-maker'),
  role('reporting-checker', 'checker', 'reporting-checker', 'reporting-checker'),
] as const;

const teamForRole = (roleName: string) => roleName.startsWith('records') || roleName.startsWith('reporting')
  ? 'records-reporting'
  : 'investments-retirement';

export const reportingToolPermissions = reportingRoles.map((entry) => ({
  team: teamForRole(entry.identity.roleName),
  roleName: entry.identity.roleName,
  roleVersion: entry.identity.roleVersion,
  toolIds: entry.identity.roleName === 'investments-retirement-lead'
    ? ['research_authoritative_web']
    : [] as const,
}));

export function registerReportingAgents(registry: AgentRegistry, input: {
  models: { lead: string; maker: string; checker: string };
  agents: Record<string, unknown>;
}): void {
  for (const entry of reportingRoles) {
    const agent = input.agents[entry.agentId];
    if (agent === undefined) throw new TypeError('Missing reporting agent ' + entry.agentId);
    registry.register({
      agentId: entry.agentId,
      modelId: input.models[entry.kind],
      roleKind: entry.kind,
      memoryEnabled: false,
      agent: agent as never,
    });
  }
}
