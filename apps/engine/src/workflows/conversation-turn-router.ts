import {
  InboundChannelMessageSchemaV1,
  type InboundChannelMessageV1,
  type OrchestratorFinalResponseV1,
  type PendingInteractionV1,
  type WorkingMemoryResolutionStatusV1,
} from '@plus-one/contracts';
import type { PendingInteractionRepository } from '@plus-one/database';
import type { OrchestratorAgent, WorkingMemoryResolutionResult } from '../agents/orchestrator.js';
import type { OrchestratorSessionMemoryPort } from '../memory/orchestrator-session-memory.js';
import { proposalExpired, workingMemoryMutationEffectIsPresent } from '../memory/working-memory-document.js';

type TerminalWorkingMemoryResolutionStatus = Exclude<WorkingMemoryResolutionStatusV1, 'pending'>;

export interface ConversationTurnRouterDependencies {
  pendingInteractions: PendingInteractionRepository;
  orchestrator: Pick<
    OrchestratorAgent,
    | 'classifyPendingWorkingMemoryInput'
    | 'resolvePendingWorkingMemoryMutation'
    | 'finalizePendingWorkingMemoryResolution'
  >;
  sessionMemory?: OrchestratorSessionMemoryPort;
  runNormalTurn(input: {
    message: InboundChannelMessageV1;
    signal?: AbortSignal;
  }): Promise<OrchestratorFinalResponseV1>;
}

export interface ConversationTurnRouterInput {
  message: InboundChannelMessageV1;
  signal?: AbortSignal;
}

export function createConversationTurnRouter(
  dependencies: ConversationTurnRouterDependencies,
): (input: ConversationTurnRouterInput) => Promise<OrchestratorFinalResponseV1> {
  return (input) => runConversationTurn(dependencies, input);
}

export async function runConversationTurn(
  dependencies: ConversationTurnRouterDependencies,
  input: ConversationTurnRouterInput,
): Promise<OrchestratorFinalResponseV1> {
  const message = InboundChannelMessageSchemaV1.parse(input.message);
  const scope = {
    householdId: message.householdId,
    conversationId: message.conversationId,
    speakerPrincipalRef: message.speaker.principalRef,
  };
  const replay = await dependencies.pendingInteractions.findByResolutionMessage({
    householdId: scope.householdId,
    conversationId: scope.conversationId,
    externalMessageId: message.externalMessageId,
  });
  if (replay?.resolutionResponse !== undefined) return replay.resolutionResponse;
  if (replay?.status === 'resolving') {
    return recoverResolvingInteraction(dependencies, replay, input);
  }

  const open = await dependencies.pendingInteractions.findOpen(scope);
  const expired = open === undefined
    ? await dependencies.pendingInteractions.findExpired(scope)
    : undefined;
  const interaction = open ?? expired;
  if (interaction === undefined) return dependencies.runNormalTurn(input);
  if (open?.status === 'resolving') return recoverResolvingInteraction(dependencies, open, input);
  if (interaction.resolutionResponse !== undefined) return interaction.resolutionResponse;

  let disposition: Awaited<ReturnType<ConversationTurnRouterDependencies['orchestrator']['classifyPendingWorkingMemoryInput']>>;
  try {
    disposition = await dependencies.orchestrator.classifyPendingWorkingMemoryInput({
      message,
      pending: interaction.pendingWorkingMemoryMutation,
      ...optionalSignal(input.signal),
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    disposition = 'ambiguous';
  }
  if (expired !== undefined) {
    if (disposition === 'new_intent') {
      const result = await dependencies.orchestrator.finalizePendingWorkingMemoryResolution({
        message,
        pending: expired.pendingWorkingMemoryMutation,
        status: 'expired',
        code: 'working_memory_proposal_expired',
        directive: 'The proposal expired before it was approved. Do not say it was completed.',
        ...optionalSignal(input.signal),
      });
      await completeIfTerminal(dependencies, expired, result, input);
      return dependencies.runNormalTurn(input);
    }
    const result = await dependencies.orchestrator.resolvePendingWorkingMemoryMutation({
      message,
      pending: expired.pendingWorkingMemoryMutation,
      decision: disposition,
      ...optionalSignal(input.signal),
    });
    return completeIfTerminal(dependencies, expired, result, input);
  }
  if (disposition === 'new_intent') return dependencies.runNormalTurn(input);
  if (disposition === 'ambiguous') {
    const result = await dependencies.orchestrator.resolvePendingWorkingMemoryMutation({
      message,
      pending: open.pendingWorkingMemoryMutation,
      decision: disposition,
      ...optionalSignal(input.signal),
    });
    if (result.status === 'pending') return result.response;
    return completeIfTerminal(dependencies, open!, result, input);
  }

  const claimed = await dependencies.pendingInteractions.claim({
    householdId: open!.householdId,
    interactionId: open!.interactionId,
    externalMessageId: message.externalMessageId,
    decision: disposition,
    expectedVersion: open!.version,
  });
  if (claimed.kind === 'replay' && claimed.interaction.resolutionResponse !== undefined) {
    return claimed.interaction.resolutionResponse;
  }
  if (claimed.kind === 'replay' && claimed.interaction.status === 'resolving') {
    return recoverResolvingInteraction(dependencies, claimed.interaction, input);
  }
  return resolveClaimedInteraction(dependencies, claimed.interaction, disposition, input);
}

async function resolveClaimedInteraction(
  dependencies: ConversationTurnRouterDependencies,
  interaction: PendingInteractionV1,
  decision: 'approve' | 'reject',
  input: ConversationTurnRouterInput,
): Promise<OrchestratorFinalResponseV1> {
  const result = await dependencies.orchestrator.resolvePendingWorkingMemoryMutation({
    message: input.message,
    pending: interaction.pendingWorkingMemoryMutation,
    decision,
    ...optionalSignal(input.signal),
  });
  return completeIfTerminal(dependencies, interaction, result, input);
}

async function recoverResolvingInteraction(
  dependencies: ConversationTurnRouterDependencies,
  interaction: PendingInteractionV1,
  input: ConversationTurnRouterInput,
): Promise<OrchestratorFinalResponseV1> {
  if (proposalExpired(interaction.expiresAt, new Date())) {
    const result = await dependencies.orchestrator.finalizePendingWorkingMemoryResolution({
      message: input.message,
      pending: interaction.pendingWorkingMemoryMutation,
      status: 'expired',
      code: 'working_memory_proposal_expired',
      directive: 'The proposal expired before it was approved. Do not say it was completed.',
      ...optionalSignal(input.signal),
    });
    return completeIfTerminal(dependencies, interaction, result, input);
  }
  if (interaction.resolutionDecision === 'reject') {
    return resolveClaimedInteraction(dependencies, interaction, 'reject', input);
  }
  if (interaction.resolutionDecision !== 'approve') {
    const result = await dependencies.orchestrator.finalizePendingWorkingMemoryResolution({
      message: input.message,
      pending: interaction.pendingWorkingMemoryMutation,
      status: 'failed',
      code: 'working_memory_resolution_decision_missing',
      directive: 'The change could not be recovered because the original decision was not recorded. Do not say it was completed; ask the user to review the proposal again.',
      ...optionalSignal(input.signal),
    });
    return completeIfTerminal(dependencies, interaction, result, input);
  }
  const memory = dependencies.sessionMemory;
  if (memory === undefined) {
    const result = await dependencies.orchestrator.finalizePendingWorkingMemoryResolution({
      message: input.message,
      pending: interaction.pendingWorkingMemoryMutation,
      status: 'failed',
      code: 'working_memory_storage_unavailable',
      directive: 'The change could not be recovered. Do not say it was completed.',
      ...optionalSignal(input.signal),
    });
    return completeIfTerminal(dependencies, interaction, result, input);
  }

  let inspection: Awaited<ReturnType<OrchestratorSessionMemoryPort['inspectWorkingMemory']>>;
  try {
    inspection = await memory.inspectWorkingMemory({
      threadId: interaction.conversationId,
      resourceId: interaction.householdId,
      principalRef: interaction.speakerPrincipalRef,
    });
  } catch {
    const result = await dependencies.orchestrator.finalizePendingWorkingMemoryResolution({
      message: input.message,
      pending: interaction.pendingWorkingMemoryMutation,
      status: 'failed',
      code: 'working_memory_storage_unavailable',
      directive: 'The change could not be recovered. Do not say it was completed.',
      ...optionalSignal(input.signal),
    });
    return completeIfTerminal(dependencies, interaction, result, input);
  }

  if (inspection.status === 'failed') {
    const result = await dependencies.orchestrator.finalizePendingWorkingMemoryResolution({
      message: input.message,
      pending: interaction.pendingWorkingMemoryMutation,
      status: 'failed',
      code: 'working_memory_storage_unavailable',
      directive: 'The change could not be recovered. Do not say it was completed.',
      ...optionalSignal(input.signal),
    });
    return completeIfTerminal(dependencies, interaction, result, input);
  }

  if (inspection.status === 'succeeded') {
    if (workingMemoryMutationEffectIsPresent({
      document: inspection.document,
      mutation: interaction.pendingWorkingMemoryMutation.mutation,
    })) {
      const result = await dependencies.orchestrator.finalizePendingWorkingMemoryResolution({
        message: input.message,
        pending: interaction.pendingWorkingMemoryMutation,
        status: 'applied',
        code: 'working_memory_mutation_recovered',
        directive: 'Confirm that the change was already verified and completed. Do not apply it again.',
        ...optionalSignal(input.signal),
      });
      return completeIfTerminal(dependencies, interaction, result, input);
    }
    if (inspection.inspection.revision !== interaction.pendingWorkingMemoryMutation.basedOnRevision) {
      const result = await dependencies.orchestrator.finalizePendingWorkingMemoryResolution({
        message: input.message,
        pending: interaction.pendingWorkingMemoryMutation,
        status: 'stale',
        code: 'working_memory_revision_stale',
        directive: 'The context changed before recovery. Do not say the change was completed; ask the user to request a fresh review.',
        ...optionalSignal(input.signal),
      });
      return completeIfTerminal(dependencies, interaction, result, input);
    }
  }

  return resolveClaimedInteraction(dependencies, interaction, 'approve', input);
}

function optionalSignal(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

async function completeIfTerminal(
  dependencies: ConversationTurnRouterDependencies,
  interaction: PendingInteractionV1,
  result: WorkingMemoryResolutionResult,
  input: ConversationTurnRouterInput,
): Promise<OrchestratorFinalResponseV1> {
  if (result.status === 'pending') return result.response;
  try {
    const completed = result.status === 'expired'
      ? await dependencies.pendingInteractions.expire({
        householdId: interaction.householdId,
        interactionId: interaction.interactionId,
        externalMessageId: input.message.externalMessageId,
        expectedVersion: interaction.version,
        resolutionCode: result.code,
        resolutionResponse: result.response,
        resolvedAt: input.message.receivedAt,
      })
      : await dependencies.pendingInteractions.complete({
        householdId: interaction.householdId,
        interactionId: interaction.interactionId,
        expectedVersion: interaction.version,
        status: result.status as TerminalWorkingMemoryResolutionStatus,
        resolutionCode: result.code,
        resolutionResponse: result.response,
        resolvedAt: input.message.receivedAt,
      });
    return completed.resolutionResponse ?? result.response;
  } catch (error) {
    const replay = await dependencies.pendingInteractions.findByResolutionMessage({
      householdId: interaction.householdId,
      conversationId: interaction.conversationId,
      externalMessageId: interaction.resolutionExternalMessageId ?? input.message.externalMessageId,
    });
    if (replay?.resolutionResponse !== undefined) return replay.resolutionResponse;
    const current = await dependencies.pendingInteractions.findById({
      householdId: interaction.householdId,
      interactionId: interaction.interactionId,
    });
    if (current?.resolutionResponse !== undefined) return current.resolutionResponse;
    throw error;
  }
}
