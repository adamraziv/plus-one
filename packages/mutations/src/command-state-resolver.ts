import { PlusOneError, type TaskStatusV1 } from '@plus-one/contracts';
import type {
  MutationCommandRecord,
  PostgresMutationCommandRepository,
} from '@plus-one/database';
import type { VerificationLedgerPort } from '@plus-one/runtime';

export class CommandStateResolver {
  constructor(private readonly dependencies: {
    commands: PostgresMutationCommandRepository;
    ledger: Pick<VerificationLedgerPort, 'findTask' | 'transition'>;
  }) {}

  async reconcile(householdId: string, commandId: string): Promise<MutationCommandRecord> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.reconcileOnce(householdId, commandId);
      } catch (error) {
        if (!(error instanceof PlusOneError)
          || (error.category !== 'serialization_conflict' && error.code !== 'stale_task_state')
          || attempt === 3) {
          throw error;
        }
      }
    }
    throw new Error('Unreachable reconciliation loop');
  }

  private async reconcileOnce(
    householdId: string,
    commandId: string,
  ): Promise<MutationCommandRecord> {
    const command = await this.dependencies.commands.findByCommandId(householdId, commandId);
    if (command === undefined) {
      throw new PlusOneError({
        category: 'validation_rejected',
        code: 'mutation_command_not_found',
        message: 'Mutation command was not found',
        retry: 'never',
        receiptLookupRequired: false,
        details: { commandId },
      });
    }
    const task = await this.dependencies.ledger.findTask(householdId, command.taskId);
    if (task === undefined) throw this.inconsistent(command, 'missing_task');

    switch (command.status) {
      case 'registered':
        if (task.status === 'checker_validated') {
          await this.transition(command, 'checker_validated', 'execution_pending',
            'recover_registered_mutation');
        } else if (task.status !== 'execution_pending') {
          throw this.inconsistent(command, task.status);
        }
        await this.dependencies.commands.markExecutionPending(householdId, commandId);
        return (await this.dependencies.commands.findByCommandId(householdId, commandId))!;
      case 'execution_pending':
        if (task.status === 'checker_validated') {
          await this.transition(command, 'checker_validated', 'execution_pending',
            'recover_pending_mutation');
        } else if (task.status !== 'execution_pending') {
          throw this.inconsistent(command, task.status);
        }
        return command;
      case 'committed':
        if (task.status === 'execution_pending') {
          await this.transition(command, 'execution_pending', 'committed',
            'recover_committed_mutation');
        } else if (task.status !== 'committed') {
          throw this.inconsistent(command, task.status);
        }
        return command;
      case 'readback_verified':
        if (task.status === 'committed') {
          await this.transition(command, 'committed', 'readback_verified',
            'recover_verified_readback');
        } else if (!['readback_verified', 'verified'].includes(task.status)) {
          throw this.inconsistent(command, task.status);
        }
        return command;
      case 'execution_failed':
        if (task.status === 'execution_pending') {
          await this.transition(command, 'execution_pending', 'execution_failed',
            'recover_execution_failure', true, command.failureCategory ?? 'runtime_failure');
        } else if (task.status !== 'execution_failed') {
          throw this.inconsistent(command, task.status);
        }
        return command;
      case 'readback_failed':
        if (task.status === 'committed') {
          await this.transition(command, 'committed', 'readback_failed',
            'recover_readback_failure', true, command.failureCategory ?? 'readback_mismatch');
        } else if (task.status !== 'readback_failed') {
          throw this.inconsistent(command, task.status);
        }
        return command;
    }
  }

  private transition(
    command: MutationCommandRecord,
    expectedFrom: TaskStatusV1,
    to: TaskStatusV1,
    reasonCode: string,
    terminal = false,
    failureCategory?: string,
  ): Promise<unknown> {
    return this.dependencies.ledger.transition({
      householdId: command.householdId,
      taskId: command.taskId,
      expectedFrom,
      to,
      reasonCode,
      responsibleComponent: 'CommandStateResolver',
      terminal,
      ...(failureCategory === undefined ? {} : { failureCategory, resumable: false }),
    });
  }

  private inconsistent(command: MutationCommandRecord, taskStatus: string): PlusOneError {
    return new PlusOneError({
      category: 'constraint_violation',
      code: 'mutation_state_inconsistent',
      message: 'Mutation command and verification task states are inconsistent',
      retry: 'after_state_resolution',
      receiptLookupRequired: true,
      details: { commandId: command.commandId, commandStatus: command.status, taskStatus },
    });
  }
}
