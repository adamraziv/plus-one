import {
  TeamLeadPlanSchemaV1,
  type SkillIdentityV1, type StopConditionV1,
  type TeamLeadPlanV1, type TeamResultEnvelopeV2,
} from '@plus-one/contracts';
import type { ExecutionStrategyRegistry } from '../strategies/execution-strategy-registry.js';
import { findWorkCell, type TeamDefinition } from '../teams/definitions.js';
import type { TeamExecutor } from './team-executor.js';
import type { TeamResultAssembler } from './team-result-assembler.js';

type WorkInput = Parameters<TeamExecutor['executeWorkCell']>[0];

export class TeamExecutionCoordinator {
  constructor(private readonly dependencies: {
    executor: TeamExecutor;
    strategies: ExecutionStrategyRegistry;
    assembler: TeamResultAssembler;
  }) {}

  validateLeadPlan(team: TeamDefinition, candidate: unknown): TeamLeadPlanV1 {
    const plan = TeamLeadPlanSchemaV1.parse(candidate);
    this.dependencies.strategies.assertAllowed(
      plan.recommendedStrategyName, team.allowedStrategyNames, plan.work.length,
    );
    for (const item of plan.work) findWorkCell(team, item.workCellId);
    return plan;
  }

  async execute(input: {
    team: TeamDefinition;
    strategyName: string;
    selectedSkill: SkillIdentityV1;
    resultTaskId: string;
    work: readonly WorkInput[];
    reconciliation?: Omit<WorkInput, 'makerInput'>;
    stopCondition: StopConditionV1;
  }): Promise<TeamResultEnvelopeV2> {
    const strategy = this.dependencies.strategies.assertAllowed(
      input.strategyName, input.team.allowedStrategyNames, input.work.length,
    );
    if (strategy.requiresCheckedReconciliation && input.reconciliation === undefined) {
      throw new Error('Adversarial strategy requires a checked reconciliation work cell');
    }
    const results = strategy.parallel
      ? await Promise.all(input.work.map((work) => this.dependencies.executor.executeWorkCell(work)))
      : await this.executeSequentially(input.work);
    let allResults = results;
    let claimSources = results;
    if (strategy.requiresCheckedReconciliation) {
      const makerInput = JSON.parse(JSON.stringify({
        checkedResults: results.map((result) => ({
          taskId: result.taskId, status: result.status,
          makerArtifactIds: result.makerArtifacts.map((artifact) => artifact.artifactId),
          checkerVerdicts: result.checkerVerdicts,
        })),
      }));
      const reconciliation = await this.dependencies.executor.executeWorkCell({
        ...input.reconciliation!, makerInput,
      });
      allResults = [...results, reconciliation];
      claimSources = [reconciliation];
    }
    const householdId = input.work[0]?.householdId ?? input.reconciliation?.householdId;
    if (householdId === undefined) throw new Error('Team execution requires at least one work item');
    return this.dependencies.assembler.assemble({
      householdId, resultTaskId: input.resultTaskId, team: input.team.team,
      strategyName: input.strategyName, selectedSkill: input.selectedSkill,
      stopCondition: input.stopCondition, results: allResults, claimSources,
    });
  }

  private async executeSequentially(work: readonly WorkInput[]) {
    const results: Awaited<ReturnType<TeamExecutor['executeWorkCell']>>[] = [];
    for (const item of work) results.push(await this.dependencies.executor.executeWorkCell(item));
    return results;
  }
}
