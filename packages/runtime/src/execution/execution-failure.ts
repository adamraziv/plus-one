import {
  LeadExecutionFailureSchemaV1,
  PlusOneError,
  type CheckerVerdictV1,
  type LeadExecutionFailureV1,
  type RoleIdentityV1,
} from '@plus-one/contracts';
import { ZodError } from 'zod';

const genericAgentCodes = new Set([
  'agent_model_failed',
  'agent_tool_failed',
]);

export function normalizeExecutionFailure(input: {
  error: unknown;
  phase: LeadExecutionFailureV1['phase'];
  role: RoleIdentityV1;
}): LeadExecutionFailureV1 {
  const plusOne = mostSpecificPlusOneError(input.error);
  if (plusOne !== undefined) {
    return LeadExecutionFailureSchemaV1.parse({
      phase: input.phase,
      role: input.role,
      category: plusOne.category,
      code: normalizeErrorCode(plusOne.code),
      retry: plusOne.retry,
    });
  }
  if (input.error instanceof ZodError) {
    return LeadExecutionFailureSchemaV1.parse({
      phase: input.phase,
      role: input.role,
      category: 'validation_rejected',
      code: 'agent_output_schema_failed',
      retry: 'safe',
      issues: input.error.issues.slice(0, 16).map((issue) => ({
        path: issue.path.length === 0 ? 'output' : issue.path.join('.'),
        code: normalizeErrorCode(issue.code),
      })),
    });
  }
  return LeadExecutionFailureSchemaV1.parse({
    phase: input.phase,
    role: input.role,
    category: 'runtime_failure',
    code: 'execution_failed',
    retry: 'after_backoff',
  });
}

export function normalizeCheckerFailure(input: {
  verdict: CheckerVerdictV1;
  role: RoleIdentityV1;
}): LeadExecutionFailureV1 {
  const revision = input.verdict.verdict === 'revision_requested';
  return LeadExecutionFailureSchemaV1.parse({
    phase: 'checker_rejection',
    role: input.role,
    category: 'checker_rejected',
    code: revision ? 'checker_revision_requested' : 'checker_rejected',
    retry: revision ? 'safe' : 'never',
    ...(input.verdict.findings.length === 0
      ? {}
      : {
          issues: input.verdict.findings.slice(0, 16).map((finding, index) => ({
            path: `checker.findings.${index}`,
            code: normalizeErrorCode(finding.code),
          })),
        }),
  });
}

function mostSpecificPlusOneError(error: unknown): PlusOneError | undefined {
  let current = error;
  let selected: PlusOneError | undefined;
  const visited = new Set<object>();
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    if (current instanceof PlusOneError) {
      selected ??= current;
      if (!genericAgentCodes.has(current.code)) selected = current;
    }
    current = current.cause;
  }
  return selected;
}

function normalizeErrorCode(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(normalized) ? normalized.slice(0, 128) : 'execution_failed';
}
