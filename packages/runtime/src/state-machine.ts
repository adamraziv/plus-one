import { PlusOneError, type TaskStatusV1 } from '@plus-one/contracts';

const allowed: Readonly<Record<TaskStatusV1, readonly TaskStatusV1[]>> = {
  created: ['skill_selected', 'failed'],
  skill_selected: ['maker_running', 'failed'],
  maker_running: ['maker_validated', 'failed'],
  maker_validated: ['checker_running', 'failed'],
  checker_running: ['checker_validated', 'failed'],
  checker_validated: [
    'verified',
    'partial',
    'insufficient_evidence',
    'conflicted',
    'failed',
    'revision_requested',
    'execution_pending',
  ],
  revision_requested: ['maker_running', 'failed'],
  execution_pending: ['committed', 'execution_failed'],
  committed: ['readback_verified', 'readback_failed'],
  readback_verified: ['verified'],
  execution_failed: [],
  readback_failed: [],
  verified: [],
  partial: [],
  insufficient_evidence: [],
  conflicted: [],
  failed: [],
};

const terminal = new Set<TaskStatusV1>([
  'execution_failed',
  'readback_failed',
  'verified',
  'partial',
  'insufficient_evidence',
  'conflicted',
  'failed',
]);

export function isAllowedTransition(from: TaskStatusV1, to: TaskStatusV1): boolean {
  return allowed[from].includes(to);
}

export function assertAllowedTransition(from: TaskStatusV1, to: TaskStatusV1): void {
  if (!isAllowedTransition(from, to)) {
    throw new PlusOneError({
      category: 'constraint_violation',
      code: 'invalid_task_transition',
      message: `Invalid task transition ${from} -> ${to}`,
      retry: 'never',
      receiptLookupRequired: false,
      details: { from, to },
    });
  }
}

export function isTerminalStatus(status: TaskStatusV1): boolean {
  return terminal.has(status);
}
