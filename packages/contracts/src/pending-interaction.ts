import { z } from 'zod';
import {
  ConversationIdSchema,
  HouseholdIdSchema,
} from './ids.js';
import {
  OrchestratorFinalResponseSchemaV1,
  type OrchestratorFinalResponseV1,
} from './channels.js';
import {
  PendingWorkingMemoryMutationSchema,
  WorkingMemoryProposalIdSchema,
  type PendingWorkingMemoryMutation,
} from './working-memory.js';
import { UtcInstantSchema } from './time.js';

export const PendingInteractionStatusSchemaV1 = z.enum([
  'pending',
  'resolving',
  'applied',
  'rejected',
  'expired',
  'stale',
  'failed',
]);

const PendingInteractionResolutionSchemaV1 = z.object({
  kind: z.literal('resolve'),
  decision: z.enum(['approve', 'reject']),
}).strict();

const PendingInteractionNewIntentSchemaV1 = z.object({
  kind: z.literal('new_intent'),
}).strict();

const PendingInteractionAmbiguousSchemaV1 = z.object({
  kind: z.literal('ambiguous'),
}).strict();

export const PendingInteractionDispositionSchemaV1 = z.discriminatedUnion('kind', [
  PendingInteractionResolutionSchemaV1,
  PendingInteractionNewIntentSchemaV1,
  PendingInteractionAmbiguousSchemaV1,
]);

export const WorkingMemoryResolutionStatusSchemaV1 = z.enum([
  'pending',
  'applied',
  'rejected',
  'expired',
  'stale',
  'failed',
]);

export const PendingInteractionSchemaV1 = z.object({
  schemaName: z.literal('pending-interaction'),
  schemaVersion: z.literal(1),
  interactionId: WorkingMemoryProposalIdSchema,
  kind: z.literal('working_memory_confirmation'),
  householdId: HouseholdIdSchema,
  conversationId: ConversationIdSchema,
  speakerPrincipalRef: z.string().min(1).max(512),
  pendingWorkingMemoryMutation: PendingWorkingMemoryMutationSchema,
  status: PendingInteractionStatusSchemaV1,
  version: z.number().int().nonnegative(),
  resolutionExternalMessageId: z.string().min(1).max(512).optional(),
  resolutionCode: z.string().regex(/^[a-z0-9_]{1,160}$/).optional(),
  resolutionResponse: OrchestratorFinalResponseSchemaV1.optional(),
  createdAt: UtcInstantSchema,
  expiresAt: UtcInstantSchema,
  resolvedAt: UtcInstantSchema.optional(),
}).strict().superRefine((interaction, context) => {
  const proposal = interaction.pendingWorkingMemoryMutation;
  type DuplicatedField = 'proposalId' | 'householdId' | 'conversationId' | 'speakerPrincipalRef' | 'createdAt' | 'expiresAt';
  const duplicatedFields: DuplicatedField[] = [
    'proposalId',
    'householdId',
    'conversationId',
    'speakerPrincipalRef',
    'createdAt',
    'expiresAt',
  ];
  const interactionFields: Record<DuplicatedField, string> = {
    proposalId: interaction.interactionId,
    householdId: interaction.householdId,
    conversationId: interaction.conversationId,
    speakerPrincipalRef: interaction.speakerPrincipalRef,
    createdAt: interaction.createdAt,
    expiresAt: interaction.expiresAt,
  };
  for (const field of duplicatedFields) {
    if (interactionFields[field] !== proposal[field]) {
      context.addIssue({
        code: 'custom',
        path: [field === 'proposalId' ? 'interactionId' : field],
        message: `Pending interaction ${String(field)} must match its proposal.`,
      });
    }
  }

  const hasExternalMessage = interaction.resolutionExternalMessageId !== undefined;
  const hasResolutionCode = interaction.resolutionCode !== undefined;
  const hasResolutionResponse = interaction.resolutionResponse !== undefined;
  const hasResolvedAt = interaction.resolvedAt !== undefined;
  if (interaction.status === 'pending') {
    if (hasExternalMessage || hasResolutionCode || hasResolutionResponse || hasResolvedAt) {
      context.addIssue({ code: 'custom', path: ['status'], message: 'Pending interactions cannot contain resolution evidence.' });
    }
    return;
  }
  if (interaction.status === 'resolving') {
    if (!hasExternalMessage) {
      context.addIssue({ code: 'custom', path: ['resolutionExternalMessageId'], message: 'Resolving interactions require the claiming message.' });
    }
    if (hasResolutionCode || hasResolutionResponse || hasResolvedAt) {
      context.addIssue({ code: 'custom', path: ['status'], message: 'Resolving interactions cannot contain terminal resolution evidence.' });
    }
    return;
  }
  if (!hasExternalMessage || !hasResolutionCode || !hasResolutionResponse || !hasResolvedAt) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'Terminal interactions require complete resolution evidence.' });
  }
});

export type PendingInteractionV1 = z.infer<typeof PendingInteractionSchemaV1>;
export type PendingInteractionStatusV1 = z.infer<typeof PendingInteractionStatusSchemaV1>;
export type PendingInteractionDispositionV1 = z.infer<typeof PendingInteractionDispositionSchemaV1>;
export type WorkingMemoryResolutionStatusV1 = z.infer<typeof WorkingMemoryResolutionStatusSchemaV1>;
export type PendingInteractionProposalV1 = PendingWorkingMemoryMutation;
export type PendingInteractionResponseV1 = OrchestratorFinalResponseV1;
