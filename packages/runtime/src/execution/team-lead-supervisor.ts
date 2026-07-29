import {
  LeadExecutionFailureSchemaV1,
  LeadExecutionRecordSchemaV1,
  TeamLeadExecutionStateSchemaV1,
  type LeadExecutionFailureV1,
  type RoleIdentityV1,
  type TeamLeadExecutionStateV1,
  type TeamLeadPlanV1,
  type TeamResultEnvelopeV2,
  type TeamResultStatusV1,
} from '@plus-one/contracts';

export interface SupervisedWorkExecution {
  taskId: string;
  workCellId: string;
  role: RoleIdentityV1;
  status: TeamResultStatusV1;
  failure?: LeadExecutionFailureV1;
}

export interface SupervisedTeamExecution {
  result: TeamResultEnvelopeV2;
  work: readonly SupervisedWorkExecution[];
}

export class TeamLeadSupervisor {
  async run(input: {
    attemptLimit: number;
    plan(state: TeamLeadExecutionStateV1, executionOrdinal: number): Promise<TeamLeadPlanV1>;
    execute(plan: TeamLeadPlanV1, executionOrdinal: number): Promise<SupervisedTeamExecution>;
  }): Promise<TeamResultEnvelopeV2> {
    const attemptLimit = Math.min(Math.max(input.attemptLimit, 1), 8);
    const executions = [];
    for (let executionOrdinal = 1; executionOrdinal <= attemptLimit; executionOrdinal += 1) {
      const state = TeamLeadExecutionStateSchemaV1.parse({
        schemaName: 'team-lead-execution-state',
        schemaVersion: 1,
        remainingAttempts: attemptLimit - executionOrdinal + 1,
        executions,
      });
      const plan = await input.plan(state, executionOrdinal);
      const execution = await input.execute(plan, executionOrdinal);
      const record = LeadExecutionRecordSchemaV1.parse({
        executionOrdinal,
        plan,
        outcome: execution.result.status === 'failed' ? 'failed' : 'succeeded',
        status: execution.result.status,
        work: execution.work.map((work) => {
          const failed = work.status === 'failed';
          return {
            taskId: work.taskId,
            workCellId: work.workCellId,
            outcome: failed ? 'failed' : 'succeeded',
            status: work.status,
            ...(failed
              ? {
                  failure: work.failure ?? fallbackFailure(
                    work.role,
                    execution.result.outstanding,
                  ),
                }
              : {}),
          };
        }),
      });
      executions.push(record);
      if (!shouldRetry(execution.result, record, executionOrdinal, attemptLimit)) {
        return execution.result;
      }
      if (madeNoProgress(executions)) return execution.result;
    }
    throw new Error('Team lead supervision attempt accounting failed');
  }
}

function shouldRetry(
  result: TeamResultEnvelopeV2,
  record: ReturnType<typeof LeadExecutionRecordSchemaV1.parse>,
  executionOrdinal: number,
  attemptLimit: number,
): boolean {
  if (executionOrdinal >= attemptLimit || result.status !== 'failed' || result.effect.state !== 'none') {
    return false;
  }
  return record.work.some((work) => work.failure?.retry !== 'never');
}

function madeNoProgress(
  executions: readonly ReturnType<typeof LeadExecutionRecordSchemaV1.parse>[],
): boolean {
  const current = executions.at(-1);
  const previous = executions.at(-2);
  if (current === undefined || previous === undefined) return false;
  return JSON.stringify(current.plan) === JSON.stringify(previous.plan)
    && failureFingerprint(current) === failureFingerprint(previous);
}

function failureFingerprint(
  execution: ReturnType<typeof LeadExecutionRecordSchemaV1.parse>,
): string {
  return execution.work
    .flatMap((work) => work.failure === undefined
      ? []
      : [`${work.workCellId}:${work.failure.phase}:${work.failure.code}`])
    .sort()
    .join('|');
}

function fallbackFailure(
  role: RoleIdentityV1,
  outstanding: readonly string[],
): LeadExecutionFailureV1 {
  const code = outstanding.find((value) => /^[a-z][a-z0-9_]{0,127}$/.test(value))
    ?? 'team_execution_failed';
  const category = code.startsWith('checker_')
    ? 'checker_rejected'
    : code.startsWith('structured_') || code.startsWith('agent_output_')
      ? 'validation_rejected'
      : 'runtime_failure';
  return LeadExecutionFailureSchemaV1.parse({
    phase: 'execution',
    role,
    category,
    code,
    retry: 'after_backoff',
  });
}
