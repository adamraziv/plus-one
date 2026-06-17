import { z } from 'zod';
import { ArtifactEnvelopeSchemaV1, CheckerVerdictSchemaV1 } from './artifacts.js';
import { HouseholdIdSchema, TaskIdSchema } from './ids.js';
import { SkillIdentitySchemaV1 } from './json.js';
import { TeamResultStatusSchemaV1 } from './runtime.js';
import { StopConditionSchemaV1 } from './invocations.js';

export const TeamClaimSchemaV1 = z.object({
  claimId: z.string().min(1).max(128),
  text: z.string().min(1).max(8_000),
  evidenceArtifactIds: z.array(z.string().min(1)),
  checkedMakerArtifactIds: z.array(z.string().min(1)).min(1),
}).strict();

export const TeamResultEnvelopeSchemaV1 = z.object({
  schemaName: z.literal('team-result'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  taskId: TaskIdSchema,
  team: z.string().regex(/^[a-z][a-z0-9-]+$/),
  status: TeamResultStatusSchemaV1,
  claims: z.array(TeamClaimSchemaV1),
  assumptions: z.array(z.string().min(1).max(2_000)),
  uncertainty: z.array(z.string().min(1).max(2_000)),
  freshness: z.array(z.string().min(1).max(2_000)),
  coverage: z.array(z.string().min(1).max(2_000)),
  makerArtifacts: z.array(ArtifactEnvelopeSchemaV1),
  checkerVerdicts: z.array(CheckerVerdictSchemaV1),
  selectedSkill: SkillIdentitySchemaV1,
  strategyName: z.string().regex(/^[a-z][a-z0-9-]+$/),
  stopCondition: StopConditionSchemaV1,
  completionReason: z.string().min(1).max(2_000),
  outstanding: z.array(z.string().min(1).max(2_000)),
}).strict().superRefine((result, context) => {
  const makers = new Map<string, string>(
    result.makerArtifacts.map((artifact) => [artifact.artifactId, artifact.artifactHash]),
  );
  const accepted = new Set<string>(result.checkerVerdicts
    .filter((verdict) => verdict.verdict === 'accepted'
      && makers.get(verdict.coveredArtifactId) === verdict.coveredArtifactHash)
    .map((verdict) => verdict.coveredArtifactId));
  for (const claim of result.claims) {
    for (const artifactId of claim.checkedMakerArtifactIds) {
      if (!accepted.has(artifactId as string)) {
        context.addIssue({ code: 'custom', message: 'Every claim must reference an accepted checked maker artifact' });
      }
    }
  }
  if (result.status === 'verified' && result.claims.length === 0) {
    context.addIssue({ code: 'custom', message: 'A verified result must contain at least one checked claim' });
  }
});

export type TeamClaimV1 = z.infer<typeof TeamClaimSchemaV1>;
export type TeamResultEnvelopeV1 = z.infer<typeof TeamResultEnvelopeSchemaV1>;
