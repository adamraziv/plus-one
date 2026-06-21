import { describe, expect, it } from 'vitest';
import {
  ArtifactIdSchema,
  QueryResultSchemaV1,
  type CheckerVerdictV1,
  type MakerArtifactV1,
} from '@plus-one/contracts';
import {
  queryRoles, queryTeamDefinition, queryToolPermissions, queryWorkCells,
} from './query-team.js';

const ARTIFACT_ID = ArtifactIdSchema.parse('artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K');

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
      .toEqual(['query-checker', 'query-lead', 'query-maker']);
  });

  it('grants query tool permission identity only to the query maker', () => {
    const maker = queryToolPermissions.find((entry) => entry.roleName === 'query-maker');
    const checker = queryToolPermissions.find((entry) => entry.roleName === 'query-checker');
    const lead = queryToolPermissions.find((entry) => entry.roleName === 'query-lead');
    expect(maker?.toolIds.length).toBeGreaterThan(0);
    expect(checker?.toolIds).toEqual([]);
    expect(lead?.toolIds).toEqual([]);
  });

  it('requires the checker rubric to verify scope, grain, filters, freshness, provenance, completeness', () => {
    const [cell] = queryWorkCells;
    expect(cell).toBeDefined();
    const instructions = cell!.checkerRubric.instructions.join(' ').toLowerCase();
    for (const keyword of ['scope', 'grain', 'filters', 'freshness', 'provenance', 'completeness']) {
      expect(instructions).toContain(keyword);
    }
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
});
