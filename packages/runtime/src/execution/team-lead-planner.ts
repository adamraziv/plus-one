import {
  TeamLeadInvocationSchemaV1,
  TeamLeadPlanSchemaV1,
  type JsonValue,
  type SkillIdentityV1,
  type TeamLeadPlanV1,
} from '@plus-one/contracts';
import type { RoleContextBuilder } from '../context/role-context-builder.js';
import type { ExecutionStrategyRegistry } from '../strategies/execution-strategy-registry.js';
import { findWorkCell, type TeamDefinition } from '../teams/definitions.js';
import type { AgentInvocationRunner } from './agent-invocation-runner.js';

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
    const plan = TeamLeadPlanSchemaV1.parse(await this.dependencies.runner.run({
      householdId: input.householdId,
      taskId: input.taskId,
      role: input.team.lead,
      attemptOrdinal: 1,
      context: this.dependencies.contexts.forLead({
        team: input.team,
        selectedSkill: input.selectedSkill,
        invocation,
      }),
      outputSchema: TeamLeadPlanSchemaV1,
      abortSignal: input.abortSignal,
    }));

    this.dependencies.strategies.assertAllowed(
      plan.recommendedStrategyName,
      input.team.allowedStrategyNames,
      plan.work.length,
    );
    for (const work of plan.work) findWorkCell(input.team, work.workCellId);
    return plan;
  }
}
