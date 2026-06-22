import { z } from 'zod';
import {
  EvidencePackageSchemaV1,
  HouseholdIdSchema,
} from '@plus-one/contracts';

const text = z.string().min(1).max(4_000);
const citation = z.string().min(1).max(512);
const disclaimer = z.literal('Plus One is an AI assistant and not a licensed financial professional.');

export const ReportingClarificationSchemaV1 = z.object({
  schemaName: z.literal('reporting-clarification'),
  schemaVersion: z.literal(1),
  missingFields: z.array(z.enum([
    'timeframe',
    'scope',
    'comparison_period',
    'scenario',
    'citation_source',
  ])).min(1),
  questions: z.array(text).min(1),
  reason: text,
}).strict();

export const InvestmentEducationRequestSchemaV1 = z.object({
  schemaName: z.literal('investment-education-request'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  evidencePackage: EvidencePackageSchemaV1,
  question: text,
}).strict();

export const InvestmentEducationOutputSchemaV1 = z.object({
  schemaName: z.literal('investment-education-output'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  policyBoundary: z.literal('informational_only'),
  summary: text,
  explanations: z.array(text).min(1),
  scenarioComparisons: z.array(text),
  citations: z.array(citation).min(1),
  disclaimer,
}).strict();

export const RetirementEducationRequestSchemaV1 = z.object({
  schemaName: z.literal('retirement-education-request'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  evidencePackage: EvidencePackageSchemaV1,
  question: text,
}).strict();

export const RetirementEducationOutputSchemaV1 = z.object({
  schemaName: z.literal('retirement-education-output'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  policyBoundary: z.literal('informational_only'),
  summary: text,
  explanations: z.array(text).min(1),
  scenarioComparisons: z.array(text),
  citations: z.array(citation).min(1),
  disclaimer,
}).strict();

export const RecordsFactRequestSchemaV1 = z.object({
  schemaName: z.literal('records-fact-request'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  evidencePackage: EvidencePackageSchemaV1,
  focus: text,
}).strict();

export const RecordsFactOutputSchemaV1 = z.object({
  schemaName: z.literal('records-fact-output'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  summary: text,
  facts: z.array(text).min(1),
  discrepancies: z.array(text),
  citations: z.array(citation).min(1),
  freshness: text,
  uncertainty: z.array(text),
}).strict();

export const ReportingBriefRequestSchemaV1 = z.object({
  schemaName: z.literal('reporting-brief-request'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  evidencePackage: EvidencePackageSchemaV1,
  recordsFacts: RecordsFactOutputSchemaV1,
  summaryGoal: text,
}).strict();

export const ReportingBriefOutputSchemaV1 = z.object({
  schemaName: z.literal('reporting-brief-output'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  headline: text,
  sections: z.array(z.object({
    title: z.string().min(1).max(160),
    body: text,
  }).strict()).min(1),
  citations: z.array(citation).min(1),
  freshness: text,
  uncertainty: z.array(text),
  policyLabels: z.array(z.string().min(1).max(128)).min(1),
  disclaimer,
}).strict();

export const InvestmentsRetirementLeadRequestSchemaV1 = z.object({
  schemaName: z.literal('investments-retirement-lead-request'),
  schemaVersion: z.literal(1),
  intent: z.enum(['investment_education', 'retirement_education']),
  request: z.json(),
}).strict();

export const RecordsReportingLeadRequestSchemaV1 = z.object({
  schemaName: z.literal('records-reporting-lead-request'),
  schemaVersion: z.literal(1),
  intent: z.enum(['records_facts', 'reporting_brief']),
  request: z.json(),
}).strict();

export type ReportingClarificationV1 = z.infer<typeof ReportingClarificationSchemaV1>;
export type InvestmentEducationRequestV1 = z.infer<typeof InvestmentEducationRequestSchemaV1>;
export type InvestmentEducationOutputV1 = z.infer<typeof InvestmentEducationOutputSchemaV1>;
export type RetirementEducationRequestV1 = z.infer<typeof RetirementEducationRequestSchemaV1>;
export type RetirementEducationOutputV1 = z.infer<typeof RetirementEducationOutputSchemaV1>;
export type RecordsFactRequestV1 = z.infer<typeof RecordsFactRequestSchemaV1>;
export type RecordsFactOutputV1 = z.infer<typeof RecordsFactOutputSchemaV1>;
export type ReportingBriefRequestV1 = z.infer<typeof ReportingBriefRequestSchemaV1>;
export type ReportingBriefOutputV1 = z.infer<typeof ReportingBriefOutputSchemaV1>;
export type InvestmentsRetirementLeadRequestV1 = z.infer<typeof InvestmentsRetirementLeadRequestSchemaV1>;
export type RecordsReportingLeadRequestV1 = z.infer<typeof RecordsReportingLeadRequestSchemaV1>;
