import {
  AnalystCalculationArtifactSchemaV1,
  AnalystTaskSchemaV1,
  EvidenceRequestSchemaV1,
  QueryResultSchemaV1,
  type CheckerVerdictV1,
  type MakerArtifactV1,
} from '@plus-one/contracts';
import type {
  AgentRoleDefinition, StopConditionEvaluation,
  TeamDefinition, WorkCellDefinition,
} from '@plus-one/runtime';

const role = (roleName: string, kind: 'lead' | 'maker' | 'checker', agentId: string,
  policyName: string): AgentRoleDefinition => ({
  identity: { roleName, roleVersion: 1 },
  kind,
  agentId,
  runtimePolicy: { policyName, policyVersion: 1 },
});

export const queryRoles = [
  role('query-lead', 'lead', 'query-lead', 'query-lead'),
  role('query-maker', 'maker', 'query-maker', 'query-maker'),
  role('query-checker', 'checker', 'query-checker', 'query-checker'),
  role('analyst-maker', 'maker', 'analyst-maker', 'analyst-maker'),
  role('analyst-checker', 'checker', 'analyst-checker', 'analyst-checker'),
] as const;

export const queryToolPermissions = [
  { team: 'query', roleName: 'query-lead', roleVersion: 1, toolIds: [] as const },
  { team: 'query', roleName: 'query-maker', roleVersion: 1,
    toolIds: ['query_account_list', 'query_current_balances', 'query_categorized_transactions',
      'query_category_spend_monthly',
      'query_budget_variance', 'query_savings_goal_progress', 'query_debt_progress',
      'query_reconciliation_status', 'query_source_freshness'] },
  { team: 'query', roleName: 'query-checker', roleVersion: 1, toolIds: [] as const },
  { team: 'query', roleName: 'analyst-maker', roleVersion: 1,
    toolIds: ['query_analyst_sandbox'] as const },
  { team: 'query', roleName: 'analyst-checker', roleVersion: 1,
    toolIds: ['query_analyst_sandbox'] as const },
] as const;

function evaluateQueryStopCondition({ maker, verdict }: {
  maker: MakerArtifactV1;
  verdict: CheckerVerdictV1;
  permittedEvidence: ReadonlyArray<unknown>;
}): StopConditionEvaluation {
  const result = QueryResultSchemaV1.safeParse(maker.output);
  if (!result.success) {
    return {
      status: 'insufficient_evidence',
      reason: 'Maker output is not a valid QueryResultV1',
      outstanding: ['query_result_schema_identity'],
    };
  }
  if (verdict.verdict !== 'accepted') {
    return {
      status: 'insufficient_evidence',
      reason: 'Checker did not accept the QueryResultV1',
      outstanding: ['query_checker_acceptance'],
    };
  }
  if (result.data.coverageWarnings.length > 0) {
    return {
      status: 'partial',
      reason: 'QueryResultV1 carries outstanding coverage warnings',
      outstanding: result.data.coverageWarnings,
    };
  }
  return {
    status: 'verified',
    reason: 'Checker accepted the QueryResultV1 with no outstanding coverage warnings',
    outstanding: [],
  };
}

function evaluateAnalystStopCondition({ maker, verdict }: {
  maker: MakerArtifactV1;
  verdict: CheckerVerdictV1;
  permittedEvidence: ReadonlyArray<unknown>;
}): StopConditionEvaluation {
  const result = AnalystCalculationArtifactSchemaV1.safeParse(maker.output);
  if (!result.success) {
    return {
      status: 'insufficient_evidence',
      reason: 'Maker output is not a valid AnalystCalculationArtifactV1',
      outstanding: ['analyst_result_schema_identity'],
    };
  }
  if (verdict.verdict !== 'accepted') {
    return {
      status: 'insufficient_evidence',
      reason: 'Analyst checker did not accept the calculation artifact',
      outstanding: ['analyst_checker_acceptance'],
    };
  }
  return {
    status: 'verified',
    reason: 'Analyst checker accepted an independently reproduced calculation artifact',
    outstanding: [],
  };
}

const queryWorkCell: WorkCellDefinition = {
  workCellId: 'query-evidence',
  maker: queryRoles.find((entry) => entry.identity.roleName === 'query-maker') as WorkCellDefinition['maker'],
  checker: queryRoles.find((entry) => entry.identity.roleName === 'query-checker') as WorkCellDefinition['checker'],
  makerInputSchema: EvidenceRequestSchemaV1,
  makerOutputSchema: QueryResultSchemaV1,
  inputSchemaIdentity: { schemaName: 'evidence-request', schemaVersion: 1 },
  outputSchemaIdentity: { schemaName: 'query-result', schemaVersion: 1 },
  effectPolicy: { kind: 'none' },
  checkerRubric: {
    rubricName: 'query-evidence-rubric',
    rubricVersion: 1,
    instructions: [
      'Verify scope: relation, household filter, and intended-use alignment.',
      'Verify grain: every requested dimension in evidence-request.desiredGrain is represented.',
      'Verify filters: requested filters appear in QueryResultV1 fields and values.',
      'Verify freshness: QueryResultV1.freshness matches evidence-request.requiredFreshness.',
      'Verify provenance: every row references an authoritative reporting relation.',
      'Verify completeness: QueryResultV1.coverageWarnings is empty before accepting.',
    ],
  },
  allowedSkillNames: ['query-evidence'],
  evaluateStopCondition: evaluateQueryStopCondition,
};

const analystWorkCell: WorkCellDefinition = {
  workCellId: 'query-analyst',
  maker: queryRoles.find((entry) => entry.identity.roleName === 'analyst-maker') as WorkCellDefinition['maker'],
  checker: queryRoles.find((entry) => entry.identity.roleName === 'analyst-checker') as WorkCellDefinition['checker'],
  makerInputSchema: AnalystTaskSchemaV1,
  makerOutputSchema: AnalystCalculationArtifactSchemaV1,
  inputSchemaIdentity: { schemaName: 'analyst-task', schemaVersion: 1 },
  outputSchemaIdentity: { schemaName: 'analyst-calculation-artifact', schemaVersion: 1 },
  effectPolicy: { kind: 'none' },
  checkerRubric: {
    rubricName: 'query-analyst-rubric',
    rubricVersion: 1,
    instructions: [
      'Verify the checked query input matches the requested calculation scope.',
      'Verify the Python code uses only the declared input payload.',
      'Reproduce or challenge material calculations in a separate clean sandbox.',
      'Reject outputs whose interpretation, calculations, or assumptions do not match the code and result payload.',
    ],
  },
  allowedSkillNames: ['query-analyst'],
  evaluateStopCondition: evaluateAnalystStopCondition,
};

export const queryWorkCells = [queryWorkCell, analystWorkCell] as const;

const lead = queryRoles.find((entry) => entry.identity.roleName === 'query-lead');
if (lead === undefined) throw new Error('query-lead role is missing');

export const queryTeamDefinition: TeamDefinition = {
  team: 'query',
  lead: lead as TeamDefinition['lead'],
  charter: 'Provide read-only evidence packages from approved reporting relations through checked maker-checker cells.',
  prohibitedBehavior: [
    'Do not execute SQL or hold database credentials.',
    'Do not write to any relation outside the read-only reporting boundary.',
    'Do not accept QueryResultV1 with unresolved coverage warnings.',
  ],
  workCells: queryWorkCells,
  allowedStrategyNames: ['single-maker-checker'],
};
