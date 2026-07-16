import {
  PlusOneError,
  type ArtifactEnvelopeV1, type CheckerRubricV1, type CheckerVerdictV1, type MakerArtifactV1,
  type RoleIdentityV1, type SchemaIdentityV1, type StopConditionV1, type TeamResultStatusV1,
} from '@plus-one/contracts';
import type { z } from 'zod';

export type TeamRoleKind = 'lead' | 'maker' | 'checker';

export type WorkCellEffectPolicy =
  | { kind: 'none' }
  | {
      kind: 'checked_mutation';
      proposals: readonly {
        schema: SchemaIdentityV1;
        confirmation: 'required' | 'optional' | 'forbidden';
      }[];
    };

export type CheckedEffectRequirement =
  | { kind: 'none' }
  | {
      kind: 'checked_mutation';
      proposalSchema: SchemaIdentityV1;
      confirmation: 'required' | 'optional' | 'forbidden';
    };

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
  effectPolicy: WorkCellEffectPolicy;
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

export interface CheckedWorkCellResult {
  householdId: string;
  taskId: string;
  team: string;
  workCellId: string;
  status: TeamResultStatusV1;
  completionState: 'terminal' | 'checked_mutation_pending';
  effectRequirement: CheckedEffectRequirement;
  makerArtifacts: readonly ArtifactEnvelopeV1[];
  checkerVerdicts: readonly CheckerVerdictV1[];
  acceptedMaker?: MakerArtifactV1;
  completionReason: string;
  outstanding: readonly string[];
}

export function assertMakerOutputSchemaIdentity(actual: SchemaIdentityV1,
  expected: SchemaIdentityV1): void {
  if (actual.schemaName !== expected.schemaName
    || actual.schemaVersion !== expected.schemaVersion) {
    throw new PlusOneError({
      category: 'validation_rejected', code: 'maker_output_schema_identity_mismatch',
      message: 'Maker output schema identity does not match the selected work-cell contract',
      retry: 'never', receiptLookupRequired: false,
      details: { expectedSchemaName: expected.schemaName,
        expectedSchemaVersion: expected.schemaVersion },
    });
  }
}
