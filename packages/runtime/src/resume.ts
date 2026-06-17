import { ResumeActionSchemaV1 } from '@plus-one/contracts';
import type { z } from 'zod';
import type { VerificationLedgerPort, VerificationTaskSnapshot } from './ledger/ports.js';
import { isTerminalStatus } from './state-machine.js';

export type ResumeActionV1 = z.infer<typeof ResumeActionSchemaV1>;

export function classifyResumeAction(task: VerificationTaskSnapshot, now: string): ResumeActionV1 {
  if (isTerminalStatus(task.status)) {
    return 'none_terminal';
  }

  if (task.status === 'execution_pending' || task.status === 'committed') {
    return 'resolve_command_state';
  }

  if (task.deadlineAt !== undefined && Date.parse(task.deadlineAt) <= Date.parse(now)) {
    return 'fail_expired';
  }

  return task.resumable ? 'retry_allowed' : 'manual_recovery_required';
}

export async function inspectResumableTasks(
  ledger: VerificationLedgerPort,
  now = new Date().toISOString(),
) {
  return (await ledger.listResumable()).map((task) => ({
    task,
    action: classifyResumeAction(task, now),
  }));
}
