import { describe, expect, it } from 'vitest';
import {
  InvestmentEducationOutputSchemaV1,
  InvestmentEducationRequestSchemaV1,
  InvestmentsRetirementLeadRequestSchemaV1,
  RecordsFactOutputSchemaV1,
  RecordsReportingLeadRequestSchemaV1,
  ReportingBriefOutputSchemaV1,
  ReportingBriefRequestSchemaV1,
  ReportingClarificationSchemaV1,
  RetirementEducationOutputSchemaV1,
} from './contracts.js';

const evidence = {
  schemaName: 'evidence-package',
  schemaVersion: 1,
  evidencePackageId: 'evidence_01JQ9000000000000000000011',
  householdId: 'hh_01JQ9000000000000000000011',
  request: {
    schemaName: 'evidence-request',
    schemaVersion: 1,
    householdId: 'hh_01JQ9000000000000000000011',
    requestId: 'evidence_01JQ9000000000000000000011',
    businessQuestion: 'Summarize our quarter.',
    intendedUse: 'reporting',
    timeframe: { start: '2026-04-01', end: '2026-06-30' },
    desiredGrain: ['month'],
    filters: [],
    requiredFreshness: 'projection freshness_at within 1 day',
    requiredCalculations: [],
    coverage: ['reporting.account_current_balances'],
  },
  status: 'verified',
  requestInterpretation: 'Quarterly reporting evidence.',
  dataScope: ['relation=reporting.account_current_balances'],
  grain: ['month'],
  filters: [],
  queryResults: [{
    schemaName: 'query-result',
    schemaVersion: 1,
    relationName: 'reporting.account_current_balances',
    grain: ['household', 'account'],
    rows: [{ account_id: 'account_01', native_amount: '1200.00' }],
    fieldDefinitions: ['account_id', 'native_amount'],
    sourceReferences: ['relation=reporting.account_current_balances'],
    freshness: 'projection freshness_at within 1 day',
    coverageWarnings: [],
  }],
  assumptions: [],
  uncertainty: ['Pending one external transfer import.'],
  queryMakerArtifactId: 'artifact_01JQ9000000000000000000012',
  queryCheckerArtifactId: 'artifact_01JQ9000000000000000000013',
  queryCheckerOutput: {
    schemaName: 'query-checker-output',
    schemaVersion: 1,
    accepted: true,
    checkedQueryResultArtifactId: 'artifact_01JQ9000000000000000000012',
    findings: [],
  },
  stopCondition: 'verified',
  completionReason: 'ok',
} as const;

describe('reporting team workflow contracts', () => {
  it('keeps investment and retirement routing typed', () => {
    expect(InvestmentsRetirementLeadRequestSchemaV1.parse({
      schemaName: 'investments-retirement-lead-request',
      schemaVersion: 1,
      intent: 'investment_education',
      request: { evidencePackage: evidence, question: 'Explain diversification.' },
    }).intent).toBe('investment_education');
  });

  it('requires checked evidence packages for investment education requests', () => {
    expect(InvestmentEducationRequestSchemaV1.parse({
      schemaName: 'investment-education-request',
      schemaVersion: 1,
      householdId: evidence.householdId,
      evidencePackage: evidence,
      question: 'Explain portfolio concentration risk.',
    }).question).toContain('portfolio');
  });

  it('keeps informational-only outputs explicit for investments and retirement', () => {
    expect(InvestmentEducationOutputSchemaV1.parse({
      schemaName: 'investment-education-output',
      schemaVersion: 1,
      householdId: evidence.householdId,
      policyBoundary: 'informational_only',
      summary: 'The holdings are concentrated in one sector.',
      explanations: ['Concentration increases volatility relative to a broader mix.'],
      scenarioComparisons: ['A broader mix may reduce single-sector swings.'],
      citations: ['Evidence Package ' + evidence.evidencePackageId],
      disclaimer: 'Plus One is an AI assistant and not a licensed financial professional.',
    }).policyBoundary).toBe('informational_only');

    expect(RetirementEducationOutputSchemaV1.parse({
      schemaName: 'retirement-education-output',
      schemaVersion: 1,
      householdId: evidence.householdId,
      policyBoundary: 'informational_only',
      summary: 'The requested projection assumes the current savings rate persists.',
      explanations: ['Changing contribution timing changes the projection inputs.'],
      scenarioComparisons: ['One scenario keeps the current rate; another increases it.'],
      citations: ['Evidence Package ' + evidence.evidencePackageId],
      disclaimer: 'Plus One is an AI assistant and not a licensed financial professional.',
    }).citations).toHaveLength(1);
  });

  it('separates clarification from records and reporting outputs', () => {
    expect(ReportingClarificationSchemaV1.parse({
      schemaName: 'reporting-clarification',
      schemaVersion: 1,
      missingFields: ['timeframe'],
      questions: ['Which reporting period should the brief cover?'],
      reason: 'The requested period is missing.',
    }).missingFields).toEqual(['timeframe']);
  });

  it('keeps records facts distinct from reporting briefs', () => {
    const records = RecordsFactOutputSchemaV1.parse({
      schemaName: 'records-fact-output',
      schemaVersion: 1,
      householdId: evidence.householdId,
      summary: 'Income covered expenses for the quarter.',
      facts: ['Cash ended the quarter higher than it started.'],
      discrepancies: ['One transfer is still pending import confirmation.'],
      citations: ['Evidence Package ' + evidence.evidencePackageId],
      freshness: 'projection freshness_at within 1 day',
      uncertainty: evidence.uncertainty,
    });

    expect(RecordsReportingLeadRequestSchemaV1.parse({
      schemaName: 'records-reporting-lead-request',
      schemaVersion: 1,
      intent: 'reporting_brief',
      request: { evidencePackage: evidence, summaryGoal: 'Quarterly household brief' },
    }).intent).toBe('reporting_brief');

    expect(ReportingBriefRequestSchemaV1.parse({
      schemaName: 'reporting-brief-request',
      schemaVersion: 1,
      householdId: evidence.householdId,
      evidencePackage: evidence,
      recordsFacts: records,
      summaryGoal: 'Quarterly household brief',
    }).summaryGoal).toContain('Quarterly');
  });

  it('requires reporting briefs to preserve freshness, uncertainty, policy labels, and disclaimer text', () => {
    expect(ReportingBriefOutputSchemaV1.parse({
      schemaName: 'reporting-brief-output',
      schemaVersion: 1,
      householdId: evidence.householdId,
      headline: 'Quarter ended with positive cash coverage.',
      sections: [
        { title: 'Cash Flow', body: 'Income exceeded recurring expenses for the quarter.' },
      ],
      citations: ['Evidence Package ' + evidence.evidencePackageId],
      freshness: 'projection freshness_at within 1 day',
      uncertainty: evidence.uncertainty,
      policyLabels: ['household_reporting'],
      disclaimer: 'Plus One is an AI assistant and not a licensed financial professional.',
    }).policyLabels).toEqual(['household_reporting']);
  });
});
