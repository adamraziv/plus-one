import { z } from 'zod';
const CROCKFORD_ULID = '[0-9A-HJKMNP-TV-Z]{26}';
function opaqueIdSchema(prefix) {
    return z
        .string()
        .regex(new RegExp(`^${prefix}_${CROCKFORD_ULID}$`), `Expected ${prefix}_ followed by a ULID`)
        .brand();
}
export const DatabaseIdSchema = z
    .string()
    .regex(/^[1-9]\d*$/, 'Expected a positive decimal database ID')
    .brand();
export const HouseholdIdSchema = opaqueIdSchema('hh');
export const TaskIdSchema = opaqueIdSchema('task');
export const RunIdSchema = opaqueIdSchema('run');
export const ArtifactIdSchema = opaqueIdSchema('artifact');
export const CommandIdSchema = opaqueIdSchema('command');
export const ReceiptIdSchema = opaqueIdSchema('receipt');
export const JobIdSchema = opaqueIdSchema('job');
export const OccurrenceIdSchema = opaqueIdSchema('occurrence');
export const DeliveryIdSchema = opaqueIdSchema('delivery');
export const ConversationIdSchema = opaqueIdSchema('conversation');
export const EvidencePackageIdSchema = opaqueIdSchema('evidence');
