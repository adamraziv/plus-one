import { z } from 'zod';
import { CurrencyCodeSchema, DecimalStringSchema } from './money.js';

export const ReportingRelationMetadataSchemaV1 = z.object({
  schemaName: z.literal('reporting-relation-metadata'),
  schemaVersion: z.literal(1),
  relationName: z.string().regex(/^reporting\.[a-z_]+$/),
  grain: z.array(z.string().min(1)).min(1),
  metrics: z.array(z.string().min(1)).min(1),
  householdScoped: z.literal(true),
  currencyBehavior: z.string().min(1),
  freshness: z.string().min(1),
  sourceSemantics: z.string().min(1),
}).strict();
export type ReportingRelationMetadataV1 = z.infer<typeof ReportingRelationMetadataSchemaV1>;

export const ProjectionHealthSchemaV1 = z.object({
  schemaName: z.literal('projection-health'),
  schemaVersion: z.literal(1),
  projectionKey: z.enum(['current_balances', 'daily_balances', 'net_worth']),
  householdId: z.string().min(1),
  projectionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  status: z.enum(['healthy', 'unhealthy', 'rebuilding']),
  checkedAt: z.string().datetime(),
  detail: z.record(z.string(), z.unknown()),
}).strict();
export type ProjectionHealthV1 = z.infer<typeof ProjectionHealthSchemaV1>;

export const ProjectionDriftRecordSchemaV1 = z.object({
  schemaName: z.literal('projection-drift-record'),
  schemaVersion: z.literal(1),
  householdId: z.string().min(1),
  projectionKey: z.enum(['current_balances', 'daily_balances', 'net_worth']),
  accountId: z.string().min(1).optional(),
  projectionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  projected: z.object({ amount: DecimalStringSchema, currency: CurrencyCodeSchema }).strict(),
  authoritative: z.object({ amount: DecimalStringSchema, currency: CurrencyCodeSchema }).strict(),
  detectedAt: z.string().datetime(),
}).strict();
export type ProjectionDriftRecordV1 = z.infer<typeof ProjectionDriftRecordSchemaV1>;
