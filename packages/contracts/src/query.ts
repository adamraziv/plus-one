import { z } from 'zod';
import { ArtifactIdSchema, EvidencePackageIdSchema, HouseholdIdSchema } from './ids.js';
import { JsonValueSchema } from './json.js';
import { TeamResultStatusSchemaV1 } from './runtime.js';
import { LocalDateSchema } from './time.js';

const ReportingRelationSchema = z.string().regex(/^reporting\.[a-z_]+$/);
const FieldNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

export const EvidenceFilterSchemaV1 = z.object({
  field: FieldNameSchema,
  op: z.enum(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'between']),
  value: JsonValueSchema,
}).strict();

export const EvidenceRequestSchemaV1 = z.object({
  schemaName: z.literal('evidence-request'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  requestId: EvidencePackageIdSchema,
  businessQuestion: z.string().min(1).max(2_000),
  intendedUse: z.string().min(1).max(512),
  timeframe: z.object({
    start: LocalDateSchema,
    end: LocalDateSchema,
  }).strict(),
  desiredGrain: z.array(z.string().min(1).max(128)).min(1).max(16),
  filters: z.array(EvidenceFilterSchemaV1).max(32),
  requiredFreshness: z.string().min(1).max(1_000),
  requiredCalculations: z.array(z.string().min(1).max(512)).max(32),
  coverage: z.array(z.string().min(1).max(512)).min(1).max(32),
}).strict();

export const QuerySpecificationSchemaV1 = z.object({
  schemaName: z.literal('query-specification'),
  schemaVersion: z.literal(1),
  relationNames: z.array(ReportingRelationSchema).min(1).max(16),
  sql: z.string().min(1).max(20_000),
  filters: z.array(EvidenceFilterSchemaV1).max(32),
  limit: z.number().int().positive().max(500),
}).strict();

export const QueryResultSchemaV1 = z.object({
  schemaName: z.literal('query-result'),
  schemaVersion: z.literal(1),
  relationName: ReportingRelationSchema,
  grain: z.array(z.string().min(1).max(128)).min(1).max(16),
  rows: z.array(JsonObjectSchema).max(500),
  fieldDefinitions: z.array(z.string().min(1).max(1_000)).min(1),
  sourceReferences: z.array(z.string().min(1).max(512)).min(1),
  freshness: z.string().min(1).max(1_000),
  coverageWarnings: z.array(z.string().min(1).max(1_000)),
}).strict();

export const QueryCheckerOutputSchemaV1 = z.object({
  schemaName: z.literal('query-checker-output'),
  schemaVersion: z.literal(1),
  accepted: z.boolean(),
  checkedQueryResultArtifactId: ArtifactIdSchema,
  findings: z.array(z.string().min(1).max(2_000)),
}).strict();

export const EvidencePackageSchemaV1 = z.object({
  schemaName: z.literal('evidence-package'),
  schemaVersion: z.literal(1),
  evidencePackageId: EvidencePackageIdSchema,
  householdId: HouseholdIdSchema,
  request: EvidenceRequestSchemaV1,
  status: TeamResultStatusSchemaV1,
  requestInterpretation: z.string().min(1).max(2_000),
  dataScope: z.array(z.string().min(1).max(512)).min(1),
  grain: z.array(z.string().min(1).max(128)).min(1).max(16),
  filters: z.array(EvidenceFilterSchemaV1).max(32),
  queryResults: z.array(QueryResultSchemaV1).min(1).max(16),
  assumptions: z.array(z.string().min(1).max(1_000)),
  uncertainty: z.array(z.string().min(1).max(1_000)),
  queryMakerArtifactId: ArtifactIdSchema,
  queryCheckerArtifactId: ArtifactIdSchema,
  queryCheckerOutput: QueryCheckerOutputSchemaV1,
  stopCondition: z.string().min(1).max(1_000),
  completionReason: z.string().min(1).max(1_000),
}).strict();

export type EvidenceRequestV1 = z.infer<typeof EvidenceRequestSchemaV1>;
export type QuerySpecificationV1 = z.infer<typeof QuerySpecificationSchemaV1>;
export type QueryResultV1 = z.infer<typeof QueryResultSchemaV1>;
export type QueryCheckerOutputV1 = z.infer<typeof QueryCheckerOutputSchemaV1>;
export type EvidencePackageV1 = z.infer<typeof EvidencePackageSchemaV1>;
