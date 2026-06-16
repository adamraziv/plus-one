import { z } from 'zod';

const CROCKFORD_ULID = '[0-9A-HJKMNP-TV-Z]{26}';

function opaqueIdSchema<const Brand extends string>(prefix: string) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_${CROCKFORD_ULID}$`), `Expected ${prefix}_ followed by a ULID`)
    .brand<Brand>();
}

export const DatabaseIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/, 'Expected a positive decimal database ID')
  .brand<'DatabaseId'>();
export type DatabaseId = z.infer<typeof DatabaseIdSchema>;

export const HouseholdIdSchema = opaqueIdSchema<'HouseholdId'>('hh');
export const TaskIdSchema = opaqueIdSchema<'TaskId'>('task');
export const RunIdSchema = opaqueIdSchema<'RunId'>('run');
export const ArtifactIdSchema = opaqueIdSchema<'ArtifactId'>('artifact');
export const CommandIdSchema = opaqueIdSchema<'CommandId'>('command');
export const ReceiptIdSchema = opaqueIdSchema<'ReceiptId'>('receipt');
export const JobIdSchema = opaqueIdSchema<'JobId'>('job');
export const OccurrenceIdSchema = opaqueIdSchema<'OccurrenceId'>('occurrence');
export const DeliveryIdSchema = opaqueIdSchema<'DeliveryId'>('delivery');
export const ConversationIdSchema = opaqueIdSchema<'ConversationId'>('conversation');
export const EvidencePackageIdSchema = opaqueIdSchema<'EvidencePackageId'>('evidence');

export type HouseholdId = z.infer<typeof HouseholdIdSchema>;
export type TaskId = z.infer<typeof TaskIdSchema>;
export type RunId = z.infer<typeof RunIdSchema>;
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;
export type CommandId = z.infer<typeof CommandIdSchema>;
export type ReceiptId = z.infer<typeof ReceiptIdSchema>;
export type JobId = z.infer<typeof JobIdSchema>;
export type OccurrenceId = z.infer<typeof OccurrenceIdSchema>;
export type DeliveryId = z.infer<typeof DeliveryIdSchema>;
export type ConversationId = z.infer<typeof ConversationIdSchema>;
export type EvidencePackageId = z.infer<typeof EvidencePackageIdSchema>;
