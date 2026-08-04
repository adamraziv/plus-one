import { z } from 'zod';

export const WorkingMemoryReplySpeechActSchemaV1 = z.enum([
  'request_confirmation',
  'confirm_applied',
  'confirm_rejected',
  'report_failure',
]);

export const WorkingMemoryReplySchemaV1 = z.object({
  speechAct: WorkingMemoryReplySpeechActSchemaV1,
  body: z.string().min(1).max(4_000),
}).strict();

export const WorkingMemoryReplyCheckSchemaV1 = z.object({
  valid: z.boolean(),
  explanation: z.string().min(1).max(1_000),
}).strict();

export type WorkingMemoryReplySpeechActV1 = z.infer<typeof WorkingMemoryReplySpeechActSchemaV1>;
export type WorkingMemoryReplyV1 = z.infer<typeof WorkingMemoryReplySchemaV1>;
export type WorkingMemoryReplyCheckV1 = z.infer<typeof WorkingMemoryReplyCheckSchemaV1>;
