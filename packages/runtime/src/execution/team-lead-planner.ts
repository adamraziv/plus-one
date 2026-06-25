import {
  JsonValueSchema,
  TeamLeadInvocationSchemaV1,
  TeamLeadPlanSchemaV1,
  type JsonValue,
  type SkillIdentityV1,
  type TeamLeadPlanV1,
} from '@plus-one/contracts';
import { z } from 'zod';
import type { RoleContextBuilder } from '../context/role-context-builder.js';
import type { ExecutionStrategyRegistry } from '../strategies/execution-strategy-registry.js';
import { findWorkCell, type TeamDefinition } from '../teams/definitions.js';
import type { AgentInvocationRunner } from './agent-invocation-runner.js';

const TeamLeadPlanDraftSchemaV1 = z.object({
  schemaName: z.literal('team-lead-plan'),
  schemaVersion: z.literal(1),
  recommendedStrategyName: z.string().min(1),
  work: z.array(z.object({
    workCellId: z.string().min(1),
    makerInput: JsonValueSchema,
  }).strict()).min(1).max(4),
  stopCondition: z.object({
    code: z.string().min(1),
    description: z.string().min(1).max(2_000),
  }).strict(),
}).strict();

export class TeamLeadPlanner {
  constructor(private readonly dependencies: {
    runner: AgentInvocationRunner;
    contexts: RoleContextBuilder;
    strategies: ExecutionStrategyRegistry;
  }) {}

  async plan(input: {
    householdId: string;
    taskId: string;
    team: TeamDefinition;
    selectedSkill: SkillIdentityV1;
    request: JsonValue;
    policyLabels: readonly string[];
    abortSignal: AbortSignal;
  }): Promise<TeamLeadPlanV1> {
    const invocation = TeamLeadInvocationSchemaV1.parse({
      schemaName: 'team-lead-invocation',
      schemaVersion: 1,
      householdId: input.householdId,
      taskId: input.taskId,
      team: input.team.team,
      role: input.team.lead.identity,
      selectedSkill: input.selectedSkill,
      request: input.request,
      availableWorkCellIds: input.team.workCells.map((cell) => cell.workCellId),
      availableStrategyNames: input.team.allowedStrategyNames,
      policyLabels: input.policyLabels,
    });
    const draft = await this.dependencies.runner.run({
      householdId: input.householdId,
      taskId: input.taskId,
      role: input.team.lead,
      attemptOrdinal: 1,
      context: this.dependencies.contexts.forLead({
        team: input.team,
        selectedSkill: input.selectedSkill,
        invocation,
      }),
      outputSchema: TeamLeadPlanDraftSchemaV1,
      abortSignal: input.abortSignal,
    });
    const plan = TeamLeadPlanSchemaV1.parse({
      ...draft,
      recommendedStrategyName: normalizeLeadIdentifier(draft.recommendedStrategyName),
      work: draft.work.map((item) => ({
        ...item,
        workCellId: normalizeLeadIdentifier(item.workCellId),
      })),
      stopCondition: {
        ...draft.stopCondition,
        code: normalizeLeadIdentifier(draft.stopCondition.code),
      },
    });

    this.dependencies.strategies.assertAllowed(
      plan.recommendedStrategyName,
      input.team.allowedStrategyNames,
      plan.work.length,
    );
    for (const work of plan.work) findWorkCell(input.team, work.workCellId);
    return plan;
  }
}

function normalizeLeadIdentifier(value: string): string {
  return value.replaceAll('_', '-');
}
