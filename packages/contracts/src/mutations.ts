import { z } from 'zod';
import { ArtifactIdSchema, HouseholdIdSchema, TaskIdSchema } from './ids.js';
import { JsonValueSchema, SchemaIdentitySchemaV1 } from './json.js';
import { opaqueIdentifierSchema } from './opaque-identifiers.js';
import { UtcInstantSchema } from './time.js';

export const ConfirmationIdSchema = opaqueIdentifierSchema<'ConfirmationId'>('confirmation');
export const MutationCommandIdSchema = opaqueIdentifierSchema<'MutationCommandId'>('command');
export const MutationReceiptIdSchema = opaqueIdentifierSchema<'MutationReceiptId'>('receipt');
export const MutationReadbackIdSchema = opaqueIdentifierSchema<'MutationReadbackId'>('mutationReadback');
export const CommandTypeSchema = z.string().regex(/^[a-z][a-z0-9_]{2,63}$/);
export const IdempotencyKeySchema = opaqueIdentifierSchema<'IdempotencyKey'>('idempotency');
export const ArtifactHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const CommandStatusSchemaV1 = z.enum([
  'registered',
  'execution_pending',
  'committed',
  'readback_verified',
  'execution_failed',
  'readback_failed',
]);

const checkedIdentity = {
  householdId: HouseholdIdSchema,
  taskId: TaskIdSchema,
  checkedProposalId: ArtifactIdSchema,
  checkedProposalHash: ArtifactHashSchema,
};

export const ExternalConfirmationSchemaV1 = z.object({
  schemaName: z.literal('external-confirmation'),
  schemaVersion: z.literal(1),
  confirmationId: ConfirmationIdSchema,
  ...checkedIdentity,
  principalId: z.string().min(1).max(256),
  channel: z.enum(['telegram', 'slack', 'other']),
  channelReference: z.string().min(1).max(512),
  confirmedAt: UtcInstantSchema,
}).strict();

export const CheckedCommandSchemaV1 = z.object({
  schemaName: z.literal('checked-command'),
  schemaVersion: z.literal(1),
  commandId: MutationCommandIdSchema,
  ...checkedIdentity,
  commandType: CommandTypeSchema,
  idempotencyKey: IdempotencyKeySchema,
  confirmationId: ConfirmationIdSchema.optional(),
  payloadSchema: SchemaIdentitySchemaV1,
  payload: JsonValueSchema,
}).strict();

export const CommittedRecordReferenceSchemaV1 = z.object({
  recordType: z.string().regex(/^[a-z][a-z0-9_.]{2,127}$/),
  recordId: z.string().min(1).max(160),
}).strict();

export const MutationReceiptSchemaV1 = z.object({
  schemaName: z.literal('mutation-receipt'),
  schemaVersion: z.literal(1),
  receiptId: MutationReceiptIdSchema,
  commandId: MutationCommandIdSchema,
  ...checkedIdentity,
  commandType: CommandTypeSchema,
  idempotencyKey: IdempotencyKeySchema,
  committedRecords: z.array(CommittedRecordReferenceSchemaV1).min(1),
  expectedState: JsonValueSchema,
  expectedStateHash: ArtifactHashSchema,
  committedAt: UtcInstantSchema,
}).strict();

export const ReadbackCheckKindSchemaV1 = z.enum([
  'identifiers',
  'row_values',
  'balances',
  'source_links',
  'artifact_links',
  'idempotency_receipt',
]);

export const ReadbackCheckSchemaV1 = z.object({
  kind: ReadbackCheckKindSchemaV1,
  status: z.enum(['passed', 'failed', 'not_applicable']),
  detailCode: z.string().min(1).max(128).optional(),
}).strict().superRefine((check, context) => {
  if (check.status === 'failed' && check.detailCode === undefined) {
    context.addIssue({ code: 'custom', message: 'Failed checks require detailCode' });
  }
});

export const ReadbackResultSchemaV1 = z.object({
  schemaName: z.literal('mutation-readback'),
  schemaVersion: z.literal(1),
  readbackId: MutationReadbackIdSchema,
  commandId: MutationCommandIdSchema,
  receiptId: MutationReceiptIdSchema,
  ok: z.boolean(),
  checks: z.array(ReadbackCheckSchemaV1).min(1),
  mismatches: z.array(z.string().min(1).max(256)),
  observedStateHash: ArtifactHashSchema,
}).strict().superRefine((result, context) => {
  const kinds = result.checks.map((check) => check.kind);
  if (new Set(kinds).size !== kinds.length) {
    context.addIssue({ code: 'custom', message: 'Read-back check kinds must be unique' });
  }

  const failed = result.checks.some((check) => check.status === 'failed');
  if ((result.ok && (failed || result.mismatches.length !== 0))
    || (!result.ok && !failed && result.mismatches.length === 0)) {
    context.addIssue({ code: 'custom', message: 'Read-back ok/mismatch state is inconsistent' });
  }
});

export type ConfirmationId = z.infer<typeof ConfirmationIdSchema>;
export type MutationCommandId = z.infer<typeof MutationCommandIdSchema>;
export type MutationReceiptId = z.infer<typeof MutationReceiptIdSchema>;
export type MutationReadbackId = z.infer<typeof MutationReadbackIdSchema>;
export type CommandStatusV1 = z.infer<typeof CommandStatusSchemaV1>;
export type ExternalConfirmationV1 = z.infer<typeof ExternalConfirmationSchemaV1>;
export type CheckedCommandV1 = z.infer<typeof CheckedCommandSchemaV1>;
export type MutationReceiptV1 = z.infer<typeof MutationReceiptSchemaV1>;
export type ReadbackCheckKindV1 = z.infer<typeof ReadbackCheckKindSchemaV1>;
export type ReadbackResultV1 = z.infer<typeof ReadbackResultSchemaV1>;
