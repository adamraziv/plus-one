import {
  TeamResultEnvelopeSchemaV1, type SkillIdentityV1, type StopConditionV1,
  type TeamResultEnvelopeV1, type TeamResultStatusV1,
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
  }): TeamResultEnvelopeV1 {
    const claimSources = input.claimSources ?? input.results;
    const accepted = claimSources.filter((result) =>
      result.status === 'verified' && result.acceptedMaker !== undefined);
    const makerArtifacts = input.results.flatMap((result) => result.makerArtifacts);
    const checkerVerdicts = input.results.flatMap((result) => result.checkerVerdicts);
    const claims = accepted.flatMap((result) => {
      const current = result.makerArtifacts.at(-1);
      if (current === undefined || result.acceptedMaker === undefined) return [];
      return result.acceptedMaker.claims.map((claim) => ({
        claimId: claim.claimId, text: claim.text,
        evidenceArtifactIds: claim.evidenceArtifactIds,
        checkedMakerArtifactIds: [current.artifactId],
      }));
    });
    const status = this.aggregateStatus(input.results, claims.length);
    return TeamResultEnvelopeSchemaV1.parse({
      schemaName: 'team-result', schemaVersion: 1,
      householdId: input.householdId, taskId: input.resultTaskId, team: input.team,
      status, claims,
      assumptions: accepted.flatMap((result) => result.acceptedMaker?.assumptions ?? []),
      uncertainty: accepted.flatMap((result) => result.acceptedMaker?.uncertainty ?? []),
      freshness: accepted.flatMap((result) => {
        const artifact = result.makerArtifacts.at(-1);
        return artifact === undefined ? [] : [artifact.artifactId + ' created ' + artifact.createdAt];
      }),
      coverage: accepted.map((result) => result.workCellId),
      makerArtifacts, checkerVerdicts, selectedSkill: input.selectedSkill,
      strategyName: input.strategyName, stopCondition: input.stopCondition,
      completionReason: input.results.map((result) => result.completionReason).join(' '),
      outstanding: input.results.flatMap((result) => result.outstanding),
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
