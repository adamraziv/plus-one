import { describe, expect, it, vi } from 'vitest';
import {
  AgentRegistry,
  SkillRegistry,
  ToolPermissionRegistry,
} from '@plus-one/runtime';
import {
  ArtifactIdSchema,
  type CheckerVerdictV1,
  type MakerArtifactV1,
} from '@plus-one/contracts';
import {
  createReportingRuntimePolicies,
  investmentsRetirementTeamDefinition,
  recordsReportingTeamDefinition,
  registerReportingAgents,
  reportingRoles,
  reportingSkills,
  reportingToolPermissions,
  validateInvestmentsRetirementLeadPlan,
  validateRecordsReportingLeadPlan,
} from '../index.js';

const ARTIFACT_ID = ArtifactIdSchema.parse('artifact_01JQ9000000000000000000021');

const verdict = (value: CheckerVerdictV1['verdict']): CheckerVerdictV1 => ({
  verdict: value,
  coveredArtifactId: ARTIFACT_ID,
  coveredArtifactHash: 'a'.repeat(64),
  findings: [],
});

const investmentMaker = (overrides: Partial<MakerArtifactV1> = {}): MakerArtifactV1 => ({
  schemaName: 'maker-artifact',
  schemaVersion: 1,
  outputSchema: { schemaName: 'investment-education-output', schemaVersion: 1 },
  output: {
    schemaName: 'investment-education-output',
    schemaVersion: 1,
    householdId: 'hh_01JQ9000000000000000000011',
    policyBoundary: 'informational_only',
    summary: 'This explains concentration risk.',
    explanations: ['A concentrated position carries more single-asset risk.'],
    scenarioComparisons: ['A broader mix changes the scenario inputs.'],
    citations: ['Evidence Package evidence_01JQ9000000000000000000011'],
    disclaimer: 'Plus One is an AI assistant and not a licensed financial professional.',
  },
  claims: [],
  assumptions: [],
  uncertainty: [],
  ...overrides,
});

const recordsMaker = (overrides: Partial<MakerArtifactV1> = {}): MakerArtifactV1 => ({
  schemaName: 'maker-artifact',
  schemaVersion: 1,
  outputSchema: { schemaName: 'records-fact-output', schemaVersion: 1 },
  output: {
    schemaName: 'records-fact-output',
    schemaVersion: 1,
    householdId: 'hh_01JQ9000000000000000000011',
    summary: 'Quarterly facts are ready.',
    facts: ['Income exceeded recurring expenses.'],
    discrepancies: [],
    citations: ['Evidence Package evidence_01JQ9000000000000000000011'],
    freshness: 'projection freshness_at within 1 day',
    uncertainty: [],
  },
  claims: [],
  assumptions: [],
  uncertainty: [],
  ...overrides,
});

const reportingMaker = (overrides: Partial<MakerArtifactV1> = {}): MakerArtifactV1 => ({
  schemaName: 'maker-artifact',
  schemaVersion: 1,
  outputSchema: { schemaName: 'reporting-brief-output', schemaVersion: 1 },
  output: {
    schemaName: 'reporting-brief-output',
    schemaVersion: 1,
    householdId: 'hh_01JQ9000000000000000000011',
    headline: 'Quarter closed with positive cash coverage.',
    sections: [{ title: 'Cash Flow', body: 'Income exceeded recurring expenses.' }],
    citations: ['Evidence Package evidence_01JQ9000000000000000000011'],
    freshness: 'projection freshness_at within 1 day',
    uncertainty: ['One transfer remains pending import confirmation.'],
    policyLabels: ['household_reporting'],
    disclaimer: 'Plus One is an AI assistant and not a licensed financial professional.',
  },
  claims: [],
  assumptions: [],
  uncertainty: [],
  ...overrides,
});

describe('reporting team registrations', () => {
  it('registers immutable skills and keeps research permission lead-only', () => {
    const skills = new SkillRegistry(reportingSkills);
    for (const skill of reportingSkills) {
      expect(skills.resolve(skill.identity).identity.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
    const tools = new ToolPermissionRegistry(reportingToolPermissions);
    for (const role of reportingRoles) {
      const team = role.agentId.startsWith('records') || role.agentId.startsWith('reporting')
        ? 'records-reporting'
        : 'investments-retirement';
      const granted = tools.resolve({
        team,
        roleName: role.identity.roleName,
        roleVersion: role.identity.roleVersion,
      });
      if (role.identity.roleName === 'investments-retirement-lead') {
        expect(granted).toEqual(['research_authoritative_web']);
      } else {
        expect(granted).toEqual([]);
      }
    }
  });

  it('registers bounded agents without memory', () => {
    const registry = new AgentRegistry();
    const agent = { generate: vi.fn() } as never;
    registerReportingAgents(registry, {
      models: { lead: 'provider/lead', maker: 'provider/maker', checker: 'provider/checker' },
      agents: Object.fromEntries(reportingRoles.map((role) => [role.agentId, agent])),
    });
    for (const role of reportingRoles) {
      expect(registry.resolve(
        role.agentId,
        role.kind === 'lead' ? 'provider/lead'
          : role.kind === 'maker' ? 'provider/maker' : 'provider/checker',
        role.kind,
      ).memoryEnabled).toBe(false);
    }
    expect(createReportingRuntimePolicies({
      leadModel: 'provider/lead',
      makerModel: 'provider/maker',
      checkerModel: 'provider/checker',
    }).every((policy) => policy.maxToolConcurrency === 1 && policy.maxAttempts <= 2)).toBe(true);
  });

  it('exposes the four advisory work cells and single-cell routing only', () => {
    expect(investmentsRetirementTeamDefinition.workCells.map((cell) => cell.workCellId)).toEqual([
      'investment-education',
      'retirement-education',
    ]);
    expect(recordsReportingTeamDefinition.workCells.map((cell) => cell.workCellId)).toEqual([
      'records-facts',
      'reporting-brief',
    ]);
    expect(investmentsRetirementTeamDefinition.allowedStrategyNames).toEqual(['single-maker-checker']);
    expect(recordsReportingTeamDefinition.allowedStrategyNames).toEqual(['single-maker-checker']);
  });

  it('routes typed lead intents to one allowed work cell', () => {
    expect(validateInvestmentsRetirementLeadPlan({
      schemaName: 'investments-retirement-lead-request',
      schemaVersion: 1,
      intent: 'investment_education',
      request: {},
    }, {
      schemaName: 'team-lead-plan',
      schemaVersion: 1,
      recommendedStrategyName: 'single-maker-checker',
      work: [{ workCellId: 'investment-education', makerInput: {} }],
      stopCondition: { code: 'checked-investment-education', description: 'Return one checked informational explanation.' },
    }).work[0]!.workCellId).toBe('investment-education');

    expect(validateRecordsReportingLeadPlan({
      schemaName: 'records-reporting-lead-request',
      schemaVersion: 1,
      intent: 'reporting_brief',
      request: {},
    }, {
      schemaName: 'team-lead-plan',
      schemaVersion: 1,
      recommendedStrategyName: 'single-maker-checker',
      work: [{ workCellId: 'reporting-brief', makerInput: {} }],
      stopCondition: { code: 'checked-reporting-brief', description: 'Return one checked household brief.' },
    }).work[0]!.workCellId).toBe('reporting-brief');
  });

  it('keeps investment education informational-only and records discrepancies partial', () => {
    const investment = investmentsRetirementTeamDefinition.workCells.find((cell) => cell.workCellId === 'investment-education');
    const records = recordsReportingTeamDefinition.workCells.find((cell) => cell.workCellId === 'records-facts');
    expect(investment?.evaluateStopCondition({
      condition: { code: 'investment', description: 'Return one checked educational explanation.' },
      maker: investmentMaker(),
      verdict: verdict('accepted'),
      permittedEvidence: [],
    }).status).toBe('verified');
    expect(investment?.evaluateStopCondition({
      condition: { code: 'investment', description: 'Return one checked educational explanation.' },
      maker: investmentMaker({
        output: { schemaName: 'investment-education-output', policyBoundary: 'personalized' } as never,
      }),
      verdict: verdict('accepted'),
      permittedEvidence: [],
    }).status).toBe('insufficient_evidence');

    expect(records?.evaluateStopCondition({
      condition: { code: 'records', description: 'Return one checked records summary.' },
      maker: recordsMaker({
        output: {
          schemaName: 'records-fact-output',
          schemaVersion: 1,
          householdId: 'hh_01JQ9000000000000000000011',
          summary: 'Facts are ready.',
          facts: ['Income exceeded recurring expenses.'],
          discrepancies: ['One transfer remains unresolved.'],
          citations: ['Evidence Package evidence_01JQ9000000000000000000011'],
          freshness: 'projection freshness_at within 1 day',
          uncertainty: [],
        },
      }),
      verdict: verdict('accepted'),
      permittedEvidence: [],
    }).status).toBe('partial');
  });

  it('preserves freshness and policy labels in reporting briefs and forbids tax or insurance improvisation', () => {
    const brief = recordsReportingTeamDefinition.workCells.find((cell) => cell.workCellId === 'reporting-brief');
    expect(brief?.evaluateStopCondition({
      condition: { code: 'brief', description: 'Return one checked household brief.' },
      maker: reportingMaker(),
      verdict: verdict('accepted'),
      permittedEvidence: [],
    }).status).toBe('verified');
    expect(recordsReportingTeamDefinition.prohibitedBehavior).toEqual(expect.arrayContaining([
      expect.stringMatching(/SQL|database credentials/),
      expect.stringMatching(/Tax|Insurance/),
      expect.stringMatching(/mutation/),
    ]));
  });
});
