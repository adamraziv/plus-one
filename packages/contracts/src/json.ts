import { z } from 'zod';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const SchemaIdentitySchemaV1 = z
  .object({
    schemaName: z.string().regex(/^[a-z][a-z0-9-]+$/),
    schemaVersion: z.number().int().positive(),
  })
  .strict();
export type SchemaIdentityV1 = z.infer<typeof SchemaIdentitySchemaV1>;

export const SkillIdentitySchemaV1 = z
  .object({
    skillName: z.string().regex(/^[a-z][a-z0-9-]+$/),
    skillVersion: z.number().int().positive(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type SkillIdentityV1 = z.infer<typeof SkillIdentitySchemaV1>;

export const RuntimePolicyIdentitySchemaV1 = z
  .object({
    policyName: z.string().regex(/^[a-z][a-z0-9-]+$/),
    policyVersion: z.number().int().positive(),
  })
  .strict();
export type RuntimePolicyIdentityV1 = z.infer<typeof RuntimePolicyIdentitySchemaV1>;
