import { z } from 'zod';
import { opaqueIdentifierSchema } from './opaque-identifiers.js';

export const DatabaseIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/, 'Expected a positive decimal database ID')
  .brand<'DatabaseId'>();
export type DatabaseId = z.infer<typeof DatabaseIdSchema>;

export const HouseholdIdSchema = opaqueIdentifierSchema<'HouseholdId'>('household');
export const TaskIdSchema = opaqueIdentifierSchema<'TaskId'>('task');
export const RunIdSchema = opaqueIdentifierSchema<'RunId'>('run');
export const ArtifactIdSchema = opaqueIdentifierSchema<'ArtifactId'>('artifact');
export const CommandIdSchema = opaqueIdentifierSchema<'CommandId'>('command');
export const ReceiptIdSchema = opaqueIdentifierSchema<'ReceiptId'>('receipt');
export const JobIdSchema = opaqueIdentifierSchema<'JobId'>('job');
export const OccurrenceIdSchema = opaqueIdentifierSchema<'OccurrenceId'>('occurrence');
export const DeliveryIdSchema = opaqueIdentifierSchema<'DeliveryId'>('delivery');
export const ConversationIdSchema = opaqueIdentifierSchema<'ConversationId'>('conversation');
export const EvidencePackageIdSchema = opaqueIdentifierSchema<'EvidencePackageId'>('evidence');

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
