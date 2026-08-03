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
import { workingMemoryMutationEffectIsPresent } from '../memory/working-memory-document.js';

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
  if (open === undefined) return dependencies.runNormalTurn(input);
  if (open.status === 'resolving') return recoverResolvingInteraction(dependencies, open, input);
  if (open.resolutionResponse !== undefined) return open.resolutionResponse;

  const disposition = await dependencies.orchestrator.classifyPendingWorkingMemoryInput({
    message,
    pending: open.pendingWorkingMemoryMutation,
    ...optionalSignal(input.signal),
  });
  if (disposition === 'new_intent') return dependencies.runNormalTurn(input);
  if (disposition === 'ambiguous') {
    const result = await dependencies.orchestrator.resolvePendingWorkingMemoryMutation({
      message,
      pending: open.pendingWorkingMemoryMutation,
      decision: disposition,
      ...optionalSignal(input.signal),
    });
    if (result.status === 'pending') return result.response;
    const claimed = await dependencies.pendingInteractions.claim({
      householdId: open.householdId,
      interactionId: open.interactionId,
      externalMessageId: message.externalMessageId,
      expectedVersion: open.version,
    });
    if (claimed.kind === 'replay' && claimed.interaction.resolutionResponse !== undefined) {
      return claimed.interaction.resolutionResponse;
    }
    return completeIfTerminal(dependencies, claimed.interaction, result, input);
  }

  const claimed = await dependencies.pendingInteractions.claim({
    householdId: open.householdId,
    interactionId: open.interactionId,
    externalMessageId: message.externalMessageId,
    expectedVersion: open.version,
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
    const completed = await dependencies.pendingInteractions.complete({
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
    throw error;
  }
}
