import { RuntimePolicySchemaV1, type RuntimePolicyV1 } from '@plus-one/contracts';
import {
  createSkillRegistration,
  type AgentRegistration,
  type AgentRegistry,
} from '@plus-one/runtime';
import { queryRoles } from './query-team.js';

export const querySkills = [
  createSkillRegistration({
    skillName: 'query-lead-routing',
    skillVersion: 1,
    content: [
      'Route one evidence request to the query-evidence work cell or one calculation request to the query-analyst work cell.',
      'Do not answer financial questions directly from conversation memory.',
      'Return one TeamLeadPlanV1 with one work item unless the selected strategy explicitly permits more.',
    ].join(' '),
    allowedTeams: ['query'],
    allowedRoles: ['query-lead'],
    makerInstructions: [],
    checkerRubric: ['Verify the selected work cell matches the request intent and required calculations.'],
  }),
  createSkillRegistration({
    skillName: 'query-evidence',
    skillVersion: 1,
    content: [
      'Produce checked read-only evidence from approved reporting relations.',
      'Use governed query tools only; never write SQL outside the allowlisted reporting boundary.',
      'Surface ambiguity as coverage warnings instead of inventing missing semantics.',
    ].join(' '),
    allowedTeams: ['query'],
    allowedRoles: ['query-maker', 'query-checker'],
    makerInstructions: [
      'Use only active query tools exposed in the invocation context.',
      'For a read request with active query tools, you must call exactly one matching active query tool before returning MakerArtifactV1.',
      'When permittedEvidence is empty, MakerArtifactV1.claims[].evidenceArtifactIds must be [] exactly; never invent evidence_* or artifact_* ids for tool outputs.',
      'Return QueryResultSchemaV1 through MakerArtifactSchemaV1.output.',
      'Cite reporting relations in sourceReferences.',
    ],
    checkerRubric: [
      'Verify relation, household filter, grain, freshness, field definitions, and provenance.',
      'Use verificationTask.makerInput as the original typed request context for request-specific checks.',
      'Treat sourceReferences entries like filter=household_id:eq:<id> as household-scope provenance for filtered read results.',
      'Reject outputs with unresolved coverage warnings for verified results.',
    ],
  }),
  createSkillRegistration({
    skillName: 'query-analyst',
    skillVersion: 1,
    content: [
      'Run Python only through the analyst sandbox over checked query data.',
      'The checker must reproduce material calculations in a separate sandbox call.',
      'Return AnalystCalculationArtifactSchemaV1 through MakerArtifactSchemaV1.output.',
    ].join(' '),
    allowedTeams: ['query'],
    allowedRoles: ['analyst-maker', 'analyst-checker'],
    makerInstructions: [
      'Use the analyst sandbox tool with the checked query result as the only input payload.',
      'Keep calculations and interpretation tied to the sandbox artifact.',
    ],
    checkerRubric: [
      'Re-run material calculations in a separate analyst sandbox invocation.',
      'Reject outputs that rely on unstated data, network access, filesystem access, or unverifiable assumptions.',
    ],
  }),
] as const;

export function createQueryRuntimePolicies(models: {
  leadModel: string;
  makerModel: string;
  checkerModel: string;
}): RuntimePolicyV1[] {
  const policy = (
    policyName: string,
    primaryModel: string,
    requiredCapabilities: RuntimePolicyV1['requiredCapabilities'],
    maxAttempts: number,
    maxSandboxReproductions = 0,
  ): RuntimePolicyV1 => RuntimePolicySchemaV1.parse({
    identity: { policyName, policyVersion: 1 },
    requiredCapabilities,
    primaryModel,
    fallbackModels: [],
    maxModelSteps: 4,
    maxToolConcurrency: 1,
    maxAttempts,
    maxModelRequestRetries: 1,
    maxProcessorRetries: 0,
    maxSandboxReproductions,
    callDeadlineMs: 20_000,
    teamDeadlineMs: 60_000,
    endToEndDeadlineMs: 90_000,
    maxOutputBytes: 128_000,
  });

  return [
    policy('query-lead', models.leadModel, ['structured_output'], 1),
    policy('query-maker', models.makerModel, ['structured_output', 'tool_calling'], 2),
    policy('query-checker', models.checkerModel, ['structured_output'], 2),
    policy('analyst-maker', models.makerModel, ['structured_output', 'tool_calling'], 2, 1),
    policy('analyst-checker', models.checkerModel, ['structured_output', 'tool_calling'], 2, 1),
  ];
}

export function registerQueryAgents(registry: AgentRegistry, input: {
  models: { lead: string; maker: string; checker: string };
  agents: Record<string, AgentRegistration['agent']>;
}): void {
  for (const role of queryRoles) {
    const agent = input.agents[role.agentId];
    if (agent === undefined) throw new TypeError('Missing query agent ' + role.agentId);
    registry.register({
      agentId: role.agentId,
      modelId: role.kind === 'lead' ? input.models.lead
        : role.kind === 'maker' ? input.models.maker
          : input.models.checker,
      roleKind: role.kind,
      memoryEnabled: false,
      agent,
    });
  }
}
