import { describe, expect, it } from 'vitest';
import {
  ArtifactIdSchema,
  EvidenceRequestSchemaV1,
  QueryResultSchemaV1,
  type CheckerVerdictV1,
  type MakerArtifactV1,
} from '@plus-one/contracts';
import {
  queryRoles, queryTeamDefinition, queryToolPermissions, queryWorkCells,
} from './query-team.js';

const ARTIFACT_ID = ArtifactIdSchema.parse('artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K');
const evidenceRequest = EvidenceRequestSchemaV1.parse({
  schemaName: 'evidence-request',
  schemaVersion: 1,
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  requestId: 'evidence_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  businessQuestion: 'List accounts.',
  intendedUse: 'household_finance_answer',
  timeframe: { start: '2026-06-01', end: '2026-06-23' },
  desiredGrain: ['household', 'account'],
  filters: [],
  requiredFreshness: 'latest projection',
  requiredCalculations: [],
  coverage: ['account list'],
});

const makerArtifact = (overrides: Partial<MakerArtifactV1> = {}): MakerArtifactV1 => ({
  schemaName: 'maker-artifact',
  schemaVersion: 1,
  outputSchema: { schemaName: 'query-result', schemaVersion: 1 },
  output: QueryResultSchemaV1.parse({
    schemaName: 'query-result',
    schemaVersion: 1,
    relationName: 'reporting.account_current_balances',
    grain: ['household', 'account'],
    rows: [{ account_id: 1, native_amount: '100.000000000000' }],
    fieldDefinitions: ['account_id', 'native_amount'],
    sourceReferences: ['relation=reporting.account_current_balances'],
    freshness: 'projection freshness_at',
    coverageWarnings: [],
  }),
  claims: [],
  assumptions: [],
  uncertainty: [],
  ...overrides,
});

const verdict = (value: CheckerVerdictV1['verdict']): CheckerVerdictV1 => ({
  verdict: value,
  coveredArtifactId: ARTIFACT_ID,
  coveredArtifactHash: 'a'.repeat(64),
  findings: [],
});

describe('query team definition', () => {
  it('exposes one lead, one query maker, and one query checker role', () => {
    expect(queryTeamDefinition.team).toBe('query');
    expect(queryTeamDefinition.lead.identity.roleName).toBe('query-lead');
    expect(queryRoles.map((entry) => entry.identity.roleName).sort())
      .toEqual(['analyst-checker', 'analyst-maker', 'query-checker', 'query-lead', 'query-maker']);
  });

  it('grants query tool permission identity only to the query maker', () => {
    const maker = queryToolPermissions.find((entry) => entry.roleName === 'query-maker');
    const checker = queryToolPermissions.find((entry) => entry.roleName === 'query-checker');
    const lead = queryToolPermissions.find((entry) => entry.roleName === 'query-lead');
    const analystMaker = queryToolPermissions.find((entry) => entry.roleName === 'analyst-maker');
    const analystChecker = queryToolPermissions.find((entry) => entry.roleName === 'analyst-checker');
    expect(maker?.toolIds.length).toBeGreaterThan(0);
    expect(checker?.toolIds).toEqual([]);
    expect(lead?.toolIds).toEqual([]);
    expect(maker?.toolIds).toEqual(expect.arrayContaining(['query_account_list']));
    expect(analystMaker?.toolIds).toEqual(['query_analyst_sandbox']);
    expect(analystChecker?.toolIds).toEqual(['query_analyst_sandbox']);
  });

  it('requires the checker rubric to verify scope, grain, filters, freshness, provenance, completeness', () => {
    const [cell] = queryWorkCells;
    expect(cell).toBeDefined();
    const instructions = cell!.checkerRubric.instructions.join(' ').toLowerCase();
    for (const keyword of ['scope', 'grain', 'filters', 'freshness', 'provenance', 'completeness']) {
      expect(instructions).toContain(keyword);
    }
  });

  it('takes an EvidenceRequestV1 as query maker input and returns QueryResultV1 output', () => {
    const [cell] = queryWorkCells;

    expect(cell!.inputSchemaIdentity).toEqual({ schemaName: 'evidence-request', schemaVersion: 1 });
    expect(cell!.outputSchemaIdentity).toEqual({ schemaName: 'query-result', schemaVersion: 1 });
    expect(cell!.makerInputSchema.parse(evidenceRequest)).toEqual(evidenceRequest);
    expect(() => cell!.makerInputSchema.parse(makerArtifact().output)).toThrow();
  });

  it('returns verified only for accepted verdicts with no outstanding coverage warnings', () => {
    const [cell] = queryWorkCells;
    const condition = { code: 'query-stop', description: 'stop after one accepted verdict' };
    expect(cell!.evaluateStopCondition({
      condition, maker: makerArtifact(), verdict: verdict('accepted'), permittedEvidence: [],
    })).toEqual({
      status: 'verified',
      reason: 'Checker accepted the QueryResultV1 with no outstanding coverage warnings',
      outstanding: [],
    });

    expect(cell!.evaluateStopCondition({
      condition, maker: makerArtifact(), verdict: verdict('revision_requested'), permittedEvidence: [],
    }).status).toBe('insufficient_evidence');

    const withWarnings = makerArtifact({
      output: QueryResultSchemaV1.parse({
        schemaName: 'query-result',
        schemaVersion: 1,
        relationName: 'reporting.account_current_balances',
        grain: ['household', 'account'],
        rows: [{ account_id: 1, native_amount: '0.000000000000' }],
        fieldDefinitions: ['account_id', 'native_amount'],
        sourceReferences: ['relation=reporting.account_current_balances'],
        freshness: 'projection freshness_at',
        coverageWarnings: ['stale projection for account 1'],
      }),
    });
    expect(cell!.evaluateStopCondition({
      condition, maker: withWarnings, verdict: verdict('accepted'), permittedEvidence: [],
    })).toEqual({
      status: 'partial',
      reason: 'QueryResultV1 carries outstanding coverage warnings',
      outstanding: ['stale projection for account 1'],
    });
  });

  it('rejects maker output that is not a valid QueryResultV1', () => {
    const [cell] = queryWorkCells;
    const condition = { code: 'query-stop', description: 'stop' };
    const bad = makerArtifact({ output: { schemaName: 'not-a-query-result' } as never });
    expect(cell!.evaluateStopCondition({
      condition, maker: bad, verdict: verdict('accepted'), permittedEvidence: [],
    }).status).toBe('insufficient_evidence');
  });

  it('exposes a second analyst work cell with its own checker rubric', () => {
    const analyst = queryWorkCells.find((entry) => entry.workCellId === 'query-analyst');
    expect(analyst?.maker.identity.roleName).toBe('analyst-maker');
    expect(analyst?.checker.identity.roleName).toBe('analyst-checker');
    expect(analyst?.allowedSkillNames).toEqual(['query-analyst']);
    expect(analyst?.checkerRubric.instructions.join(' ').toLowerCase()).toContain('reproduce');
  });
});
