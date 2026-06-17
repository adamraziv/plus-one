import { z } from 'zod';
import { ArtifactIdSchema, HouseholdIdSchema, TaskIdSchema } from './ids.js';
import { JsonValueSchema, SchemaIdentitySchemaV1 } from './json.js';
import { UtcInstantSchema } from './time.js';
export const ArtifactTypeSchemaV1 = z.enum([
    'maker_output',
    'checker_output',
    'evidence_package',
    'calculation',
    'reconciliation',
    'mutation_proposal',
    'team_result',
]);
export const ArtifactEnvelopeSchemaV1 = z
    .object({
    artifactId: ArtifactIdSchema,
    householdId: HouseholdIdSchema,
    taskId: TaskIdSchema,
    artifactType: ArtifactTypeSchemaV1,
    schema: SchemaIdentitySchemaV1,
    canonicalizationVersion: z.literal('rfc8785-v1'),
    hashAlgorithm: z.literal('sha256'),
    artifactHash: z.string().regex(/^[0-9a-f]{64}$/),
    payload: JsonValueSchema,
    createdAt: UtcInstantSchema,
})
    .strict();
const CheckerFindingSchemaV1 = z
    .object({
    code: z.string().min(1),
    message: z.string().min(1),
})
    .strict();
export const CheckerVerdictSchemaV1 = z
    .object({
    verdict: z.enum([
        'accepted',
        'rejected',
        'revision_requested',
        'insufficient_evidence',
        'conflicted',
    ]),
    coveredArtifactId: ArtifactIdSchema,
    coveredArtifactHash: z.string().regex(/^[0-9a-f]{64}$/),
    findings: z.array(CheckerFindingSchemaV1),
})
    .strict();
