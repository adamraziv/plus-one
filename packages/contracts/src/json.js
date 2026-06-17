import { z } from 'zod';
export const JsonValueSchema = z.lazy(() => z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
]));
export const SchemaIdentitySchemaV1 = z
    .object({
    schemaName: z.string().regex(/^[a-z][a-z0-9-]+$/),
    schemaVersion: z.number().int().positive(),
})
    .strict();
export const SkillIdentitySchemaV1 = z
    .object({
    skillName: z.string().regex(/^[a-z][a-z0-9-]+$/),
    skillVersion: z.number().int().positive(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
})
    .strict();
export const RuntimePolicyIdentitySchemaV1 = z
    .object({
    policyName: z.string().regex(/^[a-z][a-z0-9-]+$/),
    policyVersion: z.number().int().positive(),
})
    .strict();
