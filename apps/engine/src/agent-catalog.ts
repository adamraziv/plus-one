import type { Agent } from '@mastra/core/agent';
import {
  accountingRoles,
  accountingSkills,
  accountingTeamDefinition,
  accountingToolPermissions,
  createAccountingRuntimePolicies,
  registerAccountingAgents,
} from '@plus-one/accounting';
import {
  createIngestionRuntimePolicies,
  ingestionRoles,
  ingestionSkills,
  ingestionToolPermissions,
  registerIngestionAgents,
} from '@plus-one/ingestion';
import {
  budgetingTeamDefinition,
  cashFlowTeamDefinition,
  createPlanningRuntimePolicies,
  planningRoles,
  planningSkills,
  planningToolPermissions,
  registerPlanningAgents,
} from '@plus-one/planning';
import {
  createQueryRuntimePolicies,
  queryRoles,
  querySkills,
  queryTeamDefinition,
  queryToolPermissions,
  registerQueryAgents,
} from '@plus-one/query';
import {
  createReportingRuntimePolicies,
  investmentsRetirementTeamDefinition,
  recordsReportingTeamDefinition,
  registerReportingAgents,
  reportingRoles,
  reportingSkills,
  reportingToolPermissions,
} from '@plus-one/reporting';
import {
  AgentRegistry,
  MastraStructuredAgentAdapter,
  RoleContextBuilder,
  RuntimePolicyRegistry,
  SkillRegistry,
  ToolPermissionRegistry,
  type AgentRoleDefinition,
  type TeamDefinition,
} from '@plus-one/runtime';
import { createRoleAgent, type EngineLlmModelConfig, type RoleAgentTools } from './mastra/role-agent.js';

export interface AgentModelConfig {
  lead: EngineLlmModelConfig;
  maker: EngineLlmModelConfig;
  checker: EngineLlmModelConfig;
  research: EngineLlmModelConfig;
}

export interface AgentSystem {
  agents: AgentRegistry;
  mastraAgents: Record<string, Agent>;
  adapter: MastraStructuredAgentAdapter;
  skills: SkillRegistry;
  tools: ToolPermissionRegistry;
  policies: RuntimePolicyRegistry;
  contexts: RoleContextBuilder;
  teams: readonly TeamDefinition[];
}

export function createAgentSystem(input: {
  models: AgentModelConfig;
  queryTools: RoleAgentTools;
  agentFactory?: (input: {
    agentId: string;
    roleName: string;
    model: EngineLlmModelConfig;
    tools: RoleAgentTools;
  }) => Agent;
}): AgentSystem {
  const factory = input.agentFactory ?? createRoleAgent;
  const agents = new AgentRegistry();
  const queryAgents = makeAgents(queryRoles, input.models, input.queryTools, factory);
  const accountingAgents = makeAgents(accountingRoles, input.models, {}, factory);
  const ingestionAgents = makeAgents(ingestionRoles, input.models, {}, factory);
  const planningAgents = makeAgents(planningRoles, input.models, {}, factory);
  const reportingAgents = makeAgents(reportingRoles, input.models, {}, factory, {
    lead: input.models.research,
  });
  const mastraAgents = {
    ...queryAgents,
    ...accountingAgents,
    ...ingestionAgents,
    ...planningAgents,
    ...reportingAgents,
  };

  registerQueryAgents(agents, { models: modelIds(input.models), agents: queryAgents });
  registerAccountingAgents(agents, { models: modelIds(input.models), agents: accountingAgents });
  registerIngestionAgents(agents, {
    models: { maker: input.models.maker.id, checker: input.models.checker.id },
    agents: ingestionAgents,
  });
  registerPlanningAgents(agents, { models: modelIds(input.models), agents: planningAgents });
  registerReportingAgents(agents, {
    models: { lead: input.models.research.id, maker: input.models.maker.id, checker: input.models.checker.id },
    agents: reportingAgents,
  });

  const skills = new SkillRegistry([
    ...querySkills,
    ...accountingSkills,
    ...ingestionSkills,
    ...planningSkills,
    ...reportingSkills,
  ]);
  const tools = new ToolPermissionRegistry([
    ...queryToolPermissions,
    ...accountingToolPermissions,
    ...ingestionToolPermissions,
    ...planningToolPermissions,
    ...reportingToolPermissions,
  ]);
  const policies = new RuntimePolicyRegistry({
    models: {
      [input.models.lead.id]: ['structured_output'],
      [input.models.maker.id]: ['structured_output', 'tool_calling'],
      [input.models.checker.id]: ['structured_output', 'tool_calling'],
      [input.models.research.id]: ['structured_output', 'tool_calling', 'web_research'],
    },
    policies: [
      ...createQueryRuntimePolicies({
        leadModel: input.models.lead.id,
        makerModel: input.models.maker.id,
        checkerModel: input.models.checker.id,
      }),
      ...createAccountingRuntimePolicies({
        leadModel: input.models.lead.id,
        makerModel: input.models.maker.id,
        checkerModel: input.models.checker.id,
      }),
      ...createIngestionRuntimePolicies({
        maker: input.models.maker.id,
        checker: input.models.checker.id,
      }),
      ...createPlanningRuntimePolicies({
        leadModel: input.models.lead.id,
        makerModel: input.models.maker.id,
        checkerModel: input.models.checker.id,
      }),
      ...createReportingRuntimePolicies({
        leadModel: input.models.research.id,
        makerModel: input.models.maker.id,
        checkerModel: input.models.checker.id,
      }),
    ],
  });
  const contexts = new RoleContextBuilder({ skills, tools });

  return {
    agents,
    mastraAgents,
    adapter: new MastraStructuredAgentAdapter(agents),
    skills,
    tools,
    policies,
    contexts,
    teams: [
      queryTeamDefinition,
      accountingTeamDefinition,
      budgetingTeamDefinition,
      cashFlowTeamDefinition,
      investmentsRetirementTeamDefinition,
      recordsReportingTeamDefinition,
    ],
  };
}

function makeAgents(
  roles: readonly AgentRoleDefinition[],
  models: AgentModelConfig,
  tools: RoleAgentTools,
  factory: NonNullable<Parameters<typeof createAgentSystem>[0]['agentFactory']>,
  overrides: Partial<Record<AgentRoleDefinition['kind'], EngineLlmModelConfig>> = {},
): Record<string, Agent> {
  return Object.fromEntries([...new Map(roles.map((role) => [role.agentId, role])).values()].map((role) => [
    role.agentId,
    factory({
      agentId: role.agentId,
      roleName: role.identity.roleName,
      model: overrides[role.kind] ?? modelForKind(role.kind, models),
      tools,
    }),
  ]));
}

function modelForKind(kind: AgentRoleDefinition['kind'], models: AgentModelConfig): EngineLlmModelConfig {
  if (kind === 'lead') return models.lead;
  if (kind === 'maker') return models.maker;
  return models.checker;
}

function modelIds(models: AgentModelConfig): { lead: string; maker: string; checker: string } {
  return { lead: models.lead.id, maker: models.maker.id, checker: models.checker.id };
}
