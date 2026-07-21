import { z } from 'zod';
import { ArtifactEnvelopeSchemaV1, CheckerVerdictSchemaV1 } from './artifacts.js';
import { ArtifactHashSchema, CheckedCommandSchemaV1, MutationCommandIdSchema, MutationReceiptSchemaV1, ReadbackResultSchemaV1 } from './mutations.js';
import { ArtifactIdSchema, HouseholdIdSchema, TaskIdSchema } from './ids.js';
import { SkillIdentitySchemaV1 } from './json.js';
import { TeamResultStatusSchemaV1 } from './runtime.js';
import { StopConditionSchemaV1 } from './invocations.js';

export const TeamClaimSchemaV1 = z.object({
  claimId: z.string().min(1).max(128),
  text: z.string().min(1).max(8_000),
  evidenceArtifactIds: z.array(ArtifactIdSchema),
  checkedMakerArtifactIds: z.array(ArtifactIdSchema).min(1),
}).strict();

export const CheckedProposalReferenceSchemaV1 = z.object({
  taskId: TaskIdSchema,
  artifactId: ArtifactIdSchema,
  artifactHash: ArtifactHashSchema,
}).strict();

export const TeamEffectSchemaV1 = z.discriminatedUnion('state', [
  z.object({ state: z.literal('none') }).strict(),
  z.object({
    state: z.literal('awaiting_confirmation'),
    proposal: CheckedProposalReferenceSchemaV1,
    command: CheckedCommandSchemaV1,
  }).strict(),
  z.object({
    state: z.literal('unresolved'),
    proposal: CheckedProposalReferenceSchemaV1,
    commandId: MutationCommandIdSchema,
    reason: z.enum(['commit_ambiguous', 'readback_failed']),
  }).strict(),
  z.object({
    state: z.literal('persisted'),
    proposal: CheckedProposalReferenceSchemaV1,
    receipt: MutationReceiptSchemaV1,
    readback: ReadbackResultSchemaV1,
  }).strict(),
]);

const TeamResultEnvelopeBaseSchema = z.object({
  schemaName: z.literal('team-result'),
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
}).strict();

function refineCheckedClaims(
  result: z.infer<typeof TeamResultEnvelopeBaseSchema>,
  context: z.RefinementCtx,
): void {
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
}

export const TeamResultEnvelopeSchemaV1 = TeamResultEnvelopeBaseSchema.extend({
  schemaVersion: z.literal(1),
}).superRefine(refineCheckedClaims);

export const TeamResultEnvelopeSchemaV2 = TeamResultEnvelopeBaseSchema.extend({
  schemaVersion: z.literal(2),
  effect: TeamEffectSchemaV1,
}).superRefine((result, context) => {
  refineCheckedClaims(result, context);
  const effect = result.effect;
  if (effect.state === 'awaiting_confirmation') {
    if (result.status !== 'partial') {
      context.addIssue({ code: 'custom', message: 'Awaiting confirmation must be partial' });
    }
    if (effect.command.confirmationId !== undefined) {
      context.addIssue({ code: 'custom', message: 'A pending command cannot already be confirmed' });
    }
    if (effect.command.householdId !== result.householdId
      || effect.command.taskId !== effect.proposal.taskId
      || effect.command.checkedProposalId !== effect.proposal.artifactId
      || effect.command.checkedProposalHash !== effect.proposal.artifactHash) {
      context.addIssue({ code: 'custom', message: 'Pending command does not match checked proposal' });
    }
  }
  if (effect.state === 'persisted') {
    const { receipt, readback, proposal } = effect;
    const accepted = result.checkerVerdicts.some((verdict) =>
      verdict.verdict === 'accepted'
      && verdict.coveredArtifactId === proposal.artifactId
      && verdict.coveredArtifactHash === proposal.artifactHash);
    if (!accepted
      || result.status !== 'verified'
      || receipt.householdId !== result.householdId
      || receipt.taskId !== proposal.taskId
      || receipt.checkedProposalId !== proposal.artifactId
      || receipt.checkedProposalHash !== proposal.artifactHash
      || readback.commandId !== receipt.commandId
      || readback.receiptId !== receipt.receiptId
      || readback.ok !== true) {
      context.addIssue({ code: 'custom', message: 'Persisted effect requires exact successful proof' });
    }
  }
  if (effect.state === 'unresolved' && result.status === 'verified') {
    context.addIssue({ code: 'custom', message: 'An unresolved effect cannot be verified' });
  }
});

export type TeamClaimV1 = z.infer<typeof TeamClaimSchemaV1>;
export type CheckedProposalReferenceV1 = z.infer<typeof CheckedProposalReferenceSchemaV1>;
export type TeamEffectV1 = z.infer<typeof TeamEffectSchemaV1>;
export type TeamResultEnvelopeV1 = z.infer<typeof TeamResultEnvelopeSchemaV1>;
export type TeamResultEnvelopeV2 = z.infer<typeof TeamResultEnvelopeSchemaV2>;
