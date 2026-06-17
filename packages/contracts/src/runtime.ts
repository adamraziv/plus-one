import { z } from 'zod';
import { RuntimePolicyIdentitySchemaV1 } from './json.js';

export const TaskStatusSchemaV1 = z.enum([
  'created',
  'skill_selected',
  'maker_running',
  'maker_validated',
  'checker_running',
  'checker_validated',
  'revision_requested',
  'execution_pending',
  'committed',
  'readback_verified',
  'execution_failed',
  'readback_failed',
  'verified',
  'partial',
  'insufficient_evidence',
  'conflicted',
  'failed',
]);
export type TaskStatusV1 = z.infer<typeof TaskStatusSchemaV1>;

export const TeamResultStatusSchemaV1 = z.enum([
  'verified',
  'partial',
  'insufficient_evidence',
  'conflicted',
  'failed',
]);
export type TeamResultStatusV1 = z.infer<typeof TeamResultStatusSchemaV1>;

export const ModelCapabilitySchemaV1 = z.enum([
  'structured_output',
  'tool_calling',
  'web_research',
  'long_context',
  'vision',
]);
export type ModelCapabilityV1 = z.infer<typeof ModelCapabilitySchemaV1>;

export const RuntimePolicySchemaV1 = z
  .object({
    identity: RuntimePolicyIdentitySchemaV1,
    requiredCapabilities: z.array(ModelCapabilitySchemaV1).min(1),
    primaryModel: z.string().min(3),
    fallbackModels: z.array(z.string().min(3)),
    maxModelSteps: z.number().int().positive(),
    maxToolConcurrency: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    maxModelRequestRetries: z.number().int().nonnegative(),
    maxProcessorRetries: z.number().int().nonnegative(),
    maxSandboxReproductions: z.number().int().nonnegative(),
    callDeadlineMs: z.number().int().positive(),
    teamDeadlineMs: z.number().int().positive(),
    endToEndDeadlineMs: z.number().int().positive(),
    maxOutputBytes: z.number().int().positive(),
  })
  .strict()
  .superRefine((policy, context) => {
    if (
      policy.callDeadlineMs > policy.teamDeadlineMs ||
      policy.teamDeadlineMs > policy.endToEndDeadlineMs
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Deadlines must be ordered call <= team <= end-to-end',
      });
    }
  });
export type RuntimePolicyV1 = z.infer<typeof RuntimePolicySchemaV1>;

export const ResumeActionSchemaV1 = z.enum([
  'none_terminal',
  'retry_allowed',
  'fail_expired',
  'resolve_command_state',
  'manual_recovery_required',
]);
export type ResumeActionV1 = z.infer<typeof ResumeActionSchemaV1>;
