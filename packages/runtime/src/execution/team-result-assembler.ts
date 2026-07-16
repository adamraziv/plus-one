import {
  PlusOneError,
  TeamResultEnvelopeSchemaV2,
  type SkillIdentityV1,
  type StopConditionV1,
  type TeamResultEnvelopeV2,
  type TeamResultStatusV1,
} from '@plus-one/contracts';
import type { CheckedWorkCellResult } from '../teams/definitions.js';

export class TeamResultAssembler {
  assemble(input: {
    householdId: string;
    resultTaskId: string;
    team: string;
    strategyName: string;
    selectedSkill: SkillIdentityV1;
    stopCondition: StopConditionV1;
    results: readonly CheckedWorkCellResult[];
    claimSources?: readonly CheckedWorkCellResult[];
  }): TeamResultEnvelopeV2 {
    const mutationResults = input.results.filter((result) =>
      result.effectRequirement.kind === 'checked_mutation');
    if (mutationResults.length > 1) {
      throw new PlusOneError({
        category: 'constraint_violation',
        code: 'multiple_mutation_effects_not_supported',
        message: 'One team result may carry at most one mutation effect',
        retry: 'never',
        receiptLookupRequired: false,
        details: { mutationCount: mutationResults.length },
      });
    }
    const mutation = mutationResults[0];
    if (mutation !== undefined && mutation.mutation === undefined) {
      throw new PlusOneError({
        category: 'constraint_violation',
        code: 'checked_mutation_not_prepared',
        message: 'A checked mutation cannot reach synthesis without prepared effect state',
        retry: 'after_state_resolution',
        receiptLookupRequired: false,
        details: { taskId: mutation.taskId },
      });
    }
    if (mutation?.mutation?.state === 'prepared'
      && mutation.effectRequirement.kind === 'checked_mutation'
      && mutation.effectRequirement.confirmation !== 'required') {
      throw new PlusOneError({
        category: 'constraint_violation',
        code: 'prepared_mutation_requires_execution',
        message: 'A prepared mutation without required confirmation must execute before assembly',
        retry: 'after_state_resolution',
        receiptLookupRequired: false,
        details: { taskId: mutation.taskId },
      });
    }

    const proposalArtifact = mutation?.makerArtifacts.at(-1);
    if (mutation !== undefined && proposalArtifact === undefined) {
      throw new PlusOneError({
        category: 'constraint_violation',
        code: 'checked_mutation_proposal_missing',
        message: 'A checked mutation requires an immutable maker proposal artifact',
        retry: 'never',
        receiptLookupRequired: false,
        details: { taskId: mutation.taskId },
      });
    }
    const proposal = mutation === undefined ? undefined : {
      taskId: mutation.taskId,
      artifactId: proposalArtifact!.artifactId,
      artifactHash: proposalArtifact!.artifactHash,
    };
    const effect = mutation === undefined
      ? { state: 'none' as const }
      : mutation.mutation!.state === 'prepared'
        ? { state: 'awaiting_confirmation' as const, proposal: proposal!, command: mutation.mutation!.command }
        : mutation.mutation!.state === 'persisted'
          ? {
              state: 'persisted' as const,
              proposal: proposal!,
              receipt: mutation.mutation!.receipt,
              readback: mutation.mutation!.readback,
            }
          : {
              state: 'unresolved' as const,
              proposal: proposal!,
              commandId: mutation.mutation!.commandId,
              reason: mutation.mutation!.reason,
            };

    const claimSources = input.claimSources ?? input.results;
    const accepted = claimSources.filter((result) =>
      result.status === 'verified' && result.acceptedMaker !== undefined);
    const makerArtifacts = input.results.flatMap((result) => result.makerArtifacts);
    const checkerVerdicts = input.results.flatMap((result) => result.checkerVerdicts);
    const claims = accepted.flatMap((result) => {
      const current = result.makerArtifacts.at(-1);
      if (current === undefined || result.acceptedMaker === undefined) return [];
      return result.acceptedMaker.claims.map((claim) => ({
        claimId: claim.claimId,
        text: claim.text,
        evidenceArtifactIds: claim.evidenceArtifactIds,
        checkedMakerArtifactIds: [current.artifactId],
      }));
    });
    const status = effect.state === 'awaiting_confirmation'
      ? 'partial' as const
      : effect.state === 'unresolved'
        ? 'failed' as const
        : this.aggregateStatus(input.results, claims.length);
    return TeamResultEnvelopeSchemaV2.parse({
      schemaName: 'team-result',
      schemaVersion: 2,
      householdId: input.householdId,
      taskId: input.resultTaskId,
      team: input.team,
      status,
      claims,
      assumptions: accepted.flatMap((result) => result.acceptedMaker?.assumptions ?? []),
      uncertainty: accepted.flatMap((result) => result.acceptedMaker?.uncertainty ?? []),
      freshness: accepted.flatMap((result) => {
        const artifact = result.makerArtifacts.at(-1);
        return artifact === undefined ? [] : [artifact.artifactId + ' created ' + artifact.createdAt];
      }),
      coverage: accepted.map((result) => result.workCellId),
      makerArtifacts,
      checkerVerdicts,
      selectedSkill: input.selectedSkill,
      strategyName: input.strategyName,
      stopCondition: input.stopCondition,
      completionReason: input.results.map((result) => result.completionReason).join(' '),
      outstanding: input.results.flatMap((result) => result.outstanding),
      effect,
    });
  }

  private aggregateStatus(results: readonly CheckedWorkCellResult[], claimCount: number): TeamResultStatusV1 {
    if (results.some((result) => result.status === 'failed')) return 'failed';
    if (results.some((result) => result.status === 'conflicted')) return 'conflicted';
    if (results.every((result) => result.status === 'insufficient_evidence')) return 'insufficient_evidence';
    if (results.every((result) => result.status === 'verified') && claimCount > 0) return 'verified';
    return 'partial';
  }
}
