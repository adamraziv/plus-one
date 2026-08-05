import {
  LeadExecutionFailureSchemaV1,
  TeamLeadPlanSchemaV1,
  TeamResultEnvelopeSchemaV2,
  type TeamResultStatusV1,
} from '@plus-one/contracts';
import { describe, expect, it, vi } from 'vitest';
import { TeamLeadSupervisor } from './team-lead-supervisor.js';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const tasks = [
  'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  'task_01JNZQ4A9B8C7D6E5F4G3H2J2K',
] as const;
const role = { roleName: 'budget-maker', roleVersion: 1 } as const;

function plan(instruction: string) {
  return TeamLeadPlanSchemaV1.parse({
    schemaName: 'team-lead-plan',
    schemaVersion: 1,
    recommendedStrategyName: 'single-maker-checker',
    work: [{ workCellId: 'budgeting-intake', makerInput: { instruction } }],
    stopCondition: { code: 'budgeting-intake', description: 'Return one checked clarification.' },
  });
}

function result(status: TeamResultStatusV1, outstanding: string[] = []) {
  return TeamResultEnvelopeSchemaV2.parse({
    schemaName: 'team-result',
    schemaVersion: 2,
    householdId,
    taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J9K',
    team: 'budgeting',
    status,
    claims: [],
    assumptions: [],
    uncertainty: [],
    freshness: [],
    coverage: [],
    makerArtifacts: [],
    checkerVerdicts: [],
    selectedSkill: {
      skillName: 'budget-plan',
      skillVersion: 1,
      contentHash: 'a'.repeat(64),
    },
    strategyName: 'single-maker-checker',
    stopCondition: { code: 'budgeting-intake', description: 'Return one checked clarification.' },
    completionReason: status === 'failed' ? 'Execution failed.' : 'Execution completed.',
    outstanding,
    effect: { state: 'none' },
  });
}

function structuredFailure(retry: 'safe' | 'never' = 'safe') {
  return LeadExecutionFailureSchemaV1.parse({
    phase: 'maker_generation',
    role,
    category: 'validation_rejected',
    code: 'structured_result_not_submitted',
    retry,
  });
}

describe('TeamLeadSupervisor', () => {
  it('feeds a retryable failed execution to the next lead before executing a revised plan', async () => {
    const plans = [plan('First attempt.'), plan('Retry with the exact output contract.')];
    const planCall = vi.fn(async (state, ordinal: number) => {
      if (ordinal === 1) {
        expect(state.executions).toEqual([]);
        expect(state.remainingAttempts).toBe(2);
      } else {
        expect(state.remainingAttempts).toBe(1);
        expect(state.executions[0]).toMatchObject({
          executionOrdinal: 1,
          outcome: 'failed',
          work: [{
            workCellId: 'budgeting-intake',
            failure: {
              code: 'structured_result_not_submitted',
              retry: 'safe',
            },
          }],
        });
      }
      return plans[ordinal - 1]!;
    });
    const execute = vi.fn(async (_plan, ordinal: number) => ordinal === 1
      ? {
          result: result('failed', ['structured_result_not_submitted']),
          work: [{
            taskId: tasks[0],
            workCellId: 'budgeting-intake',
            role,
            status: 'failed' as const,
            failure: structuredFailure(),
          }],
        }
      : {
          result: result('insufficient_evidence', ['What monthly income should I use?']),
          work: [{
            taskId: tasks[1],
            workCellId: 'budgeting-intake',
            role,
            status: 'insufficient_evidence' as const,
          }],
        });

    await expect(new TeamLeadSupervisor().run({
      attemptLimit: 2,
      plan: planCall,
      execute,
    })).resolves.toMatchObject({ status: 'insufficient_evidence' });
    expect(planCall).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[0]).toEqual(plans[1]);
  });

  it('does not retry non-retryable failures', async () => {
    const planCall = vi.fn(async () => plan('Do not retry.'));
    const execute = vi.fn(async () => ({
      result: result('failed', ['structured_result_not_submitted']),
      work: [{
        taskId: tasks[0],
        workCellId: 'budgeting-intake',
        role,
        status: 'failed' as const,
        failure: structuredFailure('never'),
      }],
    }));

    await expect(new TeamLeadSupervisor().run({
      attemptLimit: 2,
      plan: planCall,
      execute,
    })).resolves.toMatchObject({ status: 'failed' });
    expect(planCall).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('stops when the same plan produces the same failure twice', async () => {
    const unchangedPlan = plan('Same attempt.');
    const planCall = vi.fn(async () => unchangedPlan);
    const execute = vi.fn(async (_plan, ordinal: number) => ({
      result: result('failed', ['structured_result_not_submitted']),
      work: [{
        taskId: tasks[(ordinal - 1) as 0 | 1],
        workCellId: 'budgeting-intake',
        role,
        status: 'failed' as const,
        failure: structuredFailure(),
      }],
    }));

    await expect(new TeamLeadSupervisor().run({
      attemptLimit: 3,
      plan: planCall,
      execute,
    })).resolves.toMatchObject({ status: 'failed' });
    expect(planCall).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
