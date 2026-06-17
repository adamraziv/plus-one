import { z } from 'zod';
import { ArtifactEnvelopeSchemaV1 } from './artifacts.js';
import { ArtifactIdSchema, HouseholdIdSchema, TaskIdSchema } from './ids.js';
import { JsonValueSchema, SchemaIdentitySchemaV1, SkillIdentitySchemaV1 } from './json.js';

export const RoleIdentitySchemaV1 = z.object({
  roleName: z.string().regex(/^[a-z][a-z0-9-]+$/),
  roleVersion: z.number().int().positive(),
}).strict();

export const StopConditionSchemaV1 = z.object({
  code: z.string().regex(/^[a-z][a-z0-9-]+$/),
  description: z.string().min(1).max(2_000),
}).strict();

export const MakerClaimSchemaV1 = z.object({
  claimId: z.string().min(1).max(128),
  text: z.string().min(1).max(8_000),
  evidenceArtifactIds: z.array(ArtifactIdSchema),
}).strict();

export const MakerInvocationSchemaV1 = z.object({
  schemaName: z.literal('maker-invocation'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  taskId: TaskIdSchema,
  team: z.string().regex(/^[a-z][a-z0-9-]+$/),
  role: RoleIdentitySchemaV1,
  skill: SkillIdentitySchemaV1,
  inputSchema: SchemaIdentitySchemaV1,
  outputSchema: SchemaIdentitySchemaV1,
  input: JsonValueSchema,
  permittedEvidence: z.array(ArtifactEnvelopeSchemaV1),
  policyLabels: z.array(z.string().min(1)).max(32),
  stopCondition: StopConditionSchemaV1,
}).strict();

export const TeamLeadInvocationSchemaV1 = z.object({
  schemaName: z.literal('team-lead-invocation'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  taskId: TaskIdSchema,
  team: z.string().regex(/^[a-z][a-z0-9-]+$/),
  role: RoleIdentitySchemaV1,
  selectedSkill: SkillIdentitySchemaV1,
  request: JsonValueSchema,
  availableWorkCellIds: z.array(z.string().regex(/^[a-z][a-z0-9-]+$/)).min(1),
  availableStrategyNames: z.array(z.string().regex(/^[a-z][a-z0-9-]+$/)).min(1),
  policyLabels: z.array(z.string().min(1)).max(32),
}).strict();

export const TeamLeadPlanSchemaV1 = z.object({
  schemaName: z.literal('team-lead-plan'),
  schemaVersion: z.literal(1),
  recommendedStrategyName: z.string().regex(/^[a-z][a-z0-9-]+$/),
  work: z.array(z.object({
    workCellId: z.string().regex(/^[a-z][a-z0-9-]+$/),
    makerInput: JsonValueSchema,
  }).strict()).min(1).max(4),
  stopCondition: StopConditionSchemaV1,
}).strict();

export const MakerArtifactSchemaV1 = z.object({
  schemaName: z.literal('maker-artifact'),
  schemaVersion: z.literal(1),
  outputSchema: SchemaIdentitySchemaV1,
  output: JsonValueSchema,
  claims: z.array(MakerClaimSchemaV1),
  assumptions: z.array(z.string().min(1).max(2_000)),
  uncertainty: z.array(z.string().min(1).max(2_000)),
}).strict();

export const CheckerRubricSchemaV1 = z.object({
  rubricName: z.string().regex(/^[a-z][a-z0-9-]+$/),
  rubricVersion: z.number().int().positive(),
  instructions: z.array(z.string().min(1).max(2_000)).min(1),
}).strict();

export const VerificationTaskSchemaV1 = z.object({
  schemaName: z.literal('verification-task'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  taskId: TaskIdSchema,
  checkerRole: RoleIdentitySchemaV1,
  makerArtifact: ArtifactEnvelopeSchemaV1,
  permittedEvidence: z.array(ArtifactEnvelopeSchemaV1),
  selectedSkill: SkillIdentitySchemaV1,
  rubric: CheckerRubricSchemaV1,
  policyLabels: z.array(z.string().min(1)).max(32),
  requiredOutputSchema: SchemaIdentitySchemaV1,
}).strict().superRefine((task, context) => {
  if (task.makerArtifact.householdId !== task.householdId || task.makerArtifact.taskId !== task.taskId) {
    context.addIssue({ code: 'custom', message: 'Maker artifact must belong to the verification task' });
  }
  const permitted = new Set(task.permittedEvidence.map((artifact) => artifact.artifactId));
  const maker = MakerArtifactSchemaV1.safeParse(task.makerArtifact.payload);
  if (!maker.success) {
    context.addIssue({ code: 'custom', message: 'Maker artifact payload must satisfy MakerArtifactSchemaV1' });
    return;
  }
  for (const claim of maker.data.claims) {
    for (const artifactId of claim.evidenceArtifactIds) {
      if (!permitted.has(artifactId)) {
        context.addIssue({ code: 'custom', message: 'Maker claim references evidence outside permittedEvidence' });
      }
    }
  }
});

export type RoleIdentityV1 = z.infer<typeof RoleIdentitySchemaV1>;
export type StopConditionV1 = z.infer<typeof StopConditionSchemaV1>;
export type TeamLeadInvocationV1 = z.infer<typeof TeamLeadInvocationSchemaV1>;
export type TeamLeadPlanV1 = z.infer<typeof TeamLeadPlanSchemaV1>;
export type MakerClaimV1 = z.infer<typeof MakerClaimSchemaV1>;
export type MakerArtifactV1 = z.infer<typeof MakerArtifactSchemaV1>;
export type MakerInvocationV1 = z.infer<typeof MakerInvocationSchemaV1>;
export type CheckerRubricV1 = z.infer<typeof CheckerRubricSchemaV1>;
export type VerificationTaskV1 = z.infer<typeof VerificationTaskSchemaV1>;
