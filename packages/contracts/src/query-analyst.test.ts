import { describe, expect, it } from 'vitest';
import {
  AnalystCalculationArtifactSchemaV1,
  AnalystTaskSchemaV1,
  EvidencePackageSchemaV1,
} from './query.js';

describe('query analyst contracts', () => {
  it('requires analyst tasks to carry checked query data and requested calculations', () => {
    const parsed = AnalystTaskSchemaV1.parse({
      schemaName: 'analyst-task',
      schemaVersion: 1,
      evidencePackageId: 'evidence_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      request: {
        schemaName: 'evidence-request',
        schemaVersion: 1,
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        requestId: 'evidence_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        businessQuestion: 'What is the grocery average per week?',
        intendedUse: 'cash-flow-review',
        timeframe: { start: '2026-06-01', end: '2026-06-30' },
        desiredGrain: ['week'],
        filters: [],
        requiredFreshness: 'projection freshness_at within 1 day',
        requiredCalculations: ['weekly average'],
        coverage: ['reporting.category_spend_monthly'],
      },
      queryResult: {
        schemaName: 'query-result',
        schemaVersion: 1,
        relationName: 'reporting.category_spend_monthly',
        grain: ['household', 'month', 'category'],
        rows: [{ category: 'groceries', spent: '240.00' }],
        fieldDefinitions: ['category', 'spent'],
        sourceReferences: ['relation=reporting.category_spend_monthly'],
        freshness: 'projection freshness_at within 1 day',
        coverageWarnings: [],
      },
    });
    expect(parsed.request.requiredCalculations).toEqual(['weekly average']);
  });

  it('requires calculation requests to carry an analyst section in the evidence package', () => {
    expect(EvidencePackageSchemaV1.safeParse({
      schemaName: 'evidence-package',
      schemaVersion: 1,
      evidencePackageId: 'evidence_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      request: {
        schemaName: 'evidence-request',
        schemaVersion: 1,
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        requestId: 'evidence_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        businessQuestion: 'What is the grocery average per week?',
        intendedUse: 'cash-flow-review',
        timeframe: { start: '2026-06-01', end: '2026-06-30' },
        desiredGrain: ['week'],
        filters: [],
        requiredFreshness: 'projection freshness_at within 1 day',
        requiredCalculations: ['weekly average'],
        coverage: ['reporting.category_spend_monthly'],
      },
      status: 'verified',
      requestInterpretation: 'Interpreted request.',
      dataScope: ['relation=reporting.category_spend_monthly'],
      grain: ['week'],
      filters: [],
      queryResults: [{
        schemaName: 'query-result',
        schemaVersion: 1,
        relationName: 'reporting.category_spend_monthly',
        grain: ['household', 'month', 'category'],
        rows: [{ category: 'groceries', spent: '240.00' }],
        fieldDefinitions: ['category', 'spent'],
        sourceReferences: ['relation=reporting.category_spend_monthly'],
        freshness: 'projection freshness_at within 1 day',
        coverageWarnings: [],
      }],
      assumptions: [],
      uncertainty: [],
      queryMakerArtifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      queryCheckerArtifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      queryCheckerOutput: {
        schemaName: 'query-checker-output',
        schemaVersion: 1,
        accepted: true,
        checkedQueryResultArtifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        findings: [],
      },
      stopCondition: 'verified',
      completionReason: 'ok',
    }).success).toBe(false);
  });

  it('captures code, inputs, outputs, assumptions, and interpretation in analyst artifacts', () => {
    expect(AnalystCalculationArtifactSchemaV1.parse({
      schemaName: 'analyst-calculation-artifact',
      schemaVersion: 1,
      pythonSource: 'result = {"average": 60}',
      inputPayload: { rows: [{ spent: '240.00' }], timeframeDays: 28 },
      stdout: '',
      stderr: '',
      exitCode: 0,
      result: { average: 60 },
      calculations: ['average weekly spend = monthly spend / 4'],
      assumptions: ['June treated as four weeks for this household review'],
      interpretation: 'Average weekly grocery spend is about 60 USD.',
    }).exitCode).toBe(0);
  });
});
