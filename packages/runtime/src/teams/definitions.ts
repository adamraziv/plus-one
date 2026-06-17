import type {
  ArtifactEnvelopeV1, CheckerRubricV1, CheckerVerdictV1, MakerArtifactV1,
  RoleIdentityV1, SchemaIdentityV1, StopConditionV1, TeamResultStatusV1,
} from '@plus-one/contracts';
import type { z } from 'zod';

export type TeamRoleKind = 'lead' | 'maker' | 'checker';

export interface AgentRoleDefinition {
  identity: RoleIdentityV1;
  kind: TeamRoleKind;
  agentId: string;
  runtimePolicy: { policyName: string; policyVersion: number };
}

export interface WorkCellDefinition {
  workCellId: string;
  maker: AgentRoleDefinition & { kind: 'maker' };
  checker: AgentRoleDefinition & { kind: 'checker' };
  makerInputSchema: z.ZodType;
  makerOutputSchema: z.ZodType;
  inputSchemaIdentity: SchemaIdentityV1;
  outputSchemaIdentity: SchemaIdentityV1;
  checkerRubric: CheckerRubricV1;
  allowedSkillNames: readonly string[];
  evaluateStopCondition(input: {
    condition: StopConditionV1;
    maker: MakerArtifactV1;
    verdict: CheckerVerdictV1;
    permittedEvidence: readonly ArtifactEnvelopeV1[];
  }): StopConditionEvaluation;
}

export interface StopConditionEvaluation {
  status: TeamResultStatusV1;
  reason: string;
  outstanding: readonly string[];
}

export interface TeamDefinition {
  team: string;
  lead: AgentRoleDefinition & { kind: 'lead' };
  charter: string;
  prohibitedBehavior: readonly string[];
  workCells: readonly WorkCellDefinition[];
  allowedStrategyNames: readonly string[];
}

export function findWorkCell(team: TeamDefinition, workCellId: string): WorkCellDefinition {
  const cell = team.workCells.find((candidate) => candidate.workCellId === workCellId);
  if (cell === undefined) throw new Error('Unknown work cell ' + team.team + '/' + workCellId);
  return cell;
}
