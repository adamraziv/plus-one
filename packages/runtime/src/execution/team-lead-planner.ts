import {
  TeamLeadInvocationSchemaV1,
  TeamLeadExecutionStateSchemaV1,
  TeamLeadPlanSchemaV1,
  type JsonValue,
  type SkillIdentityV1,
  type TeamLeadExecutionStateV1,
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
    suggestedPlan?: TeamLeadPlanV1;
    executionState?: TeamLeadExecutionStateV1;
    validatePlan?: (plan: TeamLeadPlanV1) => TeamLeadPlanV1;
    resolveMakerInput?: (workCellId: string) => JsonValue;
    abortSignal: AbortSignal;
  }): Promise<TeamLeadPlanV1> {
    const executionState = TeamLeadExecutionStateSchemaV1.parse(input.executionState ?? {
      schemaName: 'team-lead-execution-state',
      schemaVersion: 1,
      remainingAttempts: 0,
      executions: [],
    });
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
      suggestedPlan: input.suggestedPlan ?? null,
      executionState,
    });
    const resolvePlan = (draft: z.infer<typeof TeamLeadPlanDraftSchemaV1>): TeamLeadPlanV1 => {
      const plan = TeamLeadPlanSchemaV1.parse({
        ...draft,
        recommendedStrategyName: normalizeLeadIdentifier(draft.recommendedStrategyName),
        work: draft.work.map((item) => {
          const workCellId = normalizeLeadIdentifier(item.workCellId);
          const suggestedInput = input.suggestedPlan?.work
            .find((work) => work.workCellId === workCellId)?.makerInput;
          return {
            workCellId,
            makerInput: input.resolveMakerInput?.(workCellId)
              ?? suggestedInput
              ?? input.request,
          };
        }),
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
      return input.validatePlan?.(plan) ?? plan;
    };
    const outputSchema = TeamLeadPlanDraftSchemaV1.superRefine((draft, context) => {
      try {
        resolvePlan(draft);
      } catch (error) {
        context.addIssue({
          code: 'custom',
          message: `Lead plan rejected: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
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
      outputSchema,
      abortSignal: input.abortSignal,
    });
    return resolvePlan(draft);
  }
}

function normalizeLeadIdentifier(value: string): string {
  return value.replaceAll('_', '-');
}
