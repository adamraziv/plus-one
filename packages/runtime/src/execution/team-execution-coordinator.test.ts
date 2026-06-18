import { describe, expect, it, vi } from 'vitest';
import {
  ArtifactIdSchema, HouseholdIdSchema, TaskIdSchema, UtcInstantSchema,
} from '@plus-one/contracts';
import {
  ExecutionStrategyRegistry, TeamExecutionCoordinator, TeamResultAssembler,
} from '../index.js';

const skill = { skillName: 'analysis', skillVersion: 1, contentHash: 'a'.repeat(64) };

describe('TeamExecutionCoordinator', () => {
  it('runs independent makers concurrently only for an allowed parallel strategy', async () => {
    let active = 0;
    let maximum = 0;
    const executeWorkCell = vi.fn(async (input) => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return checkedResult(input.taskId);
    });
    const coordinator = new TeamExecutionCoordinator({
      executor: { executeWorkCell } as never,
      strategies: ExecutionStrategyRegistry.withRequiredStrategies(),
      assembler: new TeamResultAssembler(),
    });
    const result = await coordinator.execute({
      team: { team: 'query', allowedStrategyNames: ['parallel-independent-makers'] } as never,
      strategyName: 'parallel-independent-makers', selectedSkill: skill,
      resultTaskId: TaskIdSchema.parse('task_01JNZQ4A9B8C7D6E5F4G3H2J9K'),
      work: [{ taskId: TaskIdSchema.parse('task_01JNZQ4A9B8C7D6E5F4G3H2J1K'),
        householdId: HouseholdIdSchema.parse('hh_01JNZQ4A9B8C7D6E5F4G3H2J1K') },
        { taskId: TaskIdSchema.parse('task_01JNZQ4A9B8C7D6E5F4G3H2J2K'),
        householdId: HouseholdIdSchema.parse('hh_01JNZQ4A9B8C7D6E5F4G3H2J1K') }] as never,
      stopCondition: { code: 'two-views', description: 'Return two independently checked views.' },
    });
    expect(maximum).toBe(2);
    expect(result.status).toBe('verified');
  });

  it('rejects adversarial execution without a checked reconciliation cell', async () => {
    const coordinator = new TeamExecutionCoordinator({
      executor: { executeWorkCell: vi.fn() } as never,
      strategies: ExecutionStrategyRegistry.withRequiredStrategies(),
      assembler: new TeamResultAssembler(),
    });
    await expect(coordinator.execute({
      team: { team: 'query', allowedStrategyNames: ['adversarial-analysis-reconciliation'] } as never,
      strategyName: 'adversarial-analysis-reconciliation', selectedSkill: skill,
      resultTaskId: TaskIdSchema.parse('task_01JNZQ4A9B8C7D6E5F4G3H2J9K'),
      work: [{}, {}] as never,
      stopCondition: { code: 'reconciled', description: 'Return checked reconciliation.' },
    })).rejects.toThrow(/reconciliation/);
  });

  it('validates a lead recommendation against registered cells and strategies', () => {
    const coordinator = new TeamExecutionCoordinator({
      executor: { executeWorkCell: vi.fn() } as never,
      strategies: ExecutionStrategyRegistry.withRequiredStrategies(),
      assembler: new TeamResultAssembler(),
    });
    expect(() => coordinator.validateLeadPlan({
      team: 'query', workCells: [], allowedStrategyNames: ['single-maker-checker'],
    } as never, {
      schemaName: 'team-lead-plan', schemaVersion: 1,
      recommendedStrategyName: 'parallel-independent-makers',
      work: [{ workCellId: 'missing', makerInput: {} }],
      stopCondition: { code: 'done', description: 'Complete checked work.' },
    })).toThrow();
  });

  it('rejects a checked mutation result before read-back completion', () => {
    const assembler = new TeamResultAssembler();
    const deferred = {
      ...checkedResult('task_01JNZQ4A9B8C7D6E5F4G3H2J1K'),
      completionState: 'checked_mutation_pending' as const,
    };
    try {
      assembler.assemble({
        householdId: deferred.householdId,
        resultTaskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J9K',
        team: 'accounting',
        strategyName: 'single-maker-checker',
        selectedSkill: skill,
        stopCondition: { code: 'persisted', description: 'Require checked persistence.' },
        results: [deferred],
      });
      throw new Error('Expected deferred mutation assembly to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'checked_mutation_not_terminal' });
    }
  });
});

function checkedResult(taskId: string) {
  const endsIn1K = taskId.endsWith('1K');
  const householdId = HouseholdIdSchema.parse('hh_01JNZQ4A9B8C7D6E5F4G3H2J1K');
  const parsedTaskId = TaskIdSchema.parse(taskId);
  const artifactId = ArtifactIdSchema.parse(
    endsIn1K ? 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K' : 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K');
  const artifactHash = endsIn1K ? 'b'.repeat(64) : 'c'.repeat(64);
  return {
    householdId,
    taskId, team: 'query', workCellId: 'analysis',
    status: 'verified' as const,
    completionState: 'terminal' as const,
    makerArtifacts: [{ artifactId, householdId, taskId: parsedTaskId,
      artifactType: 'maker_output' as const, schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
      canonicalizationVersion: 'rfc8785-v1' as const, hashAlgorithm: 'sha256' as const, artifactHash,
      payload: { schemaName: 'maker-artifact', schemaVersion: 1,
        outputSchema: { schemaName: 'analysis-output', schemaVersion: 1 }, output: { view: taskId },
        claims: [{ claimId: taskId, text: 'Checked view ' + taskId, evidenceArtifactIds: [] }],
        assumptions: [], uncertainty: [] },
      createdAt: UtcInstantSchema.parse('2026-06-14T10:00:00.000Z') }],
    checkerVerdicts: [{ verdict: 'accepted' as const, coveredArtifactId: artifactId, coveredArtifactHash: artifactHash,
      findings: [] }],
    acceptedMaker: { schemaName: 'maker-artifact' as const, schemaVersion: 1 as const,
      outputSchema: { schemaName: 'analysis-output', schemaVersion: 1 }, output: { view: taskId },
      claims: [{ claimId: taskId, text: 'Checked view ' + taskId, evidenceArtifactIds: [] }],
      assumptions: [], uncertainty: [] },
    completionReason: 'accepted', outstanding: [],
  };
}
