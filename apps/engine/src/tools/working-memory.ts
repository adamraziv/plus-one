import { createTool } from '@mastra/core/tools';
import {
  ErrorCategorySchemaV1,
  RetryDirectiveSchemaV1,
  type InboundChannelMessageV1,
} from '@plus-one/contracts';
import type {
  OrchestratorSessionMemoryPort,
  WorkingMemoryOperationOutcome,
} from '../memory/orchestrator-session-memory.js';
import { z } from 'zod';

const ForgetEverythingInputSchema = z.object({}).strict();
const ForgetEverythingResultSchema = z.object({
  operation: z.literal('clear'),
  status: z.enum(['succeeded', 'failed']),
  code: z.string().min(1).max(128),
  category: ErrorCategorySchemaV1.optional(),
  retry: RetryDirectiveSchemaV1.optional(),
}).strict();

type ActiveInvocation = {
  message: Pick<InboundChannelMessageV1, 'conversationId' | 'householdId' | 'speaker'>;
  signal: AbortSignal;
};

export function createForgetEverythingTool(input: {
  memory: OrchestratorSessionMemoryPort;
  getActiveInvocation(): ActiveInvocation | undefined;
  recordOutcome?(outcome: WorkingMemoryOperationOutcome): void;
}) {
  return createTool({
    id: 'forgetEverything',
    description: [
      'Clear all Plus One Working Memory for the authenticated household resource.',
      'This does not delete accounting facts, transactions, channel history, or workflow snapshots.',
      'Do not provide a household, thread, or member identifier to this tool.',
    ].join(' '),
    inputSchema: ForgetEverythingInputSchema,
    outputSchema: ForgetEverythingResultSchema,
    execute: async () => {
      const active = input.getActiveInvocation();
      if (active === undefined) {
        const outcome = noActiveInvocationOutcome();
        input.recordOutcome?.(outcome);
        return ForgetEverythingResultSchema.parse(outcome);
      }
      if (active.signal.aborted) {
        throw active.signal.reason ?? new DOMException('Working Memory clear aborted.', 'AbortError');
      }

      let outcome: WorkingMemoryOperationOutcome;
      try {
        outcome = await input.memory.clearWorkingMemory({
          threadId: active.message.conversationId,
          resourceId: active.message.householdId,
        });
      } catch {
        outcome = unexpectedFailureOutcome();
      }
      input.recordOutcome?.(outcome);
      return ForgetEverythingResultSchema.parse(outcome);
    },
  });
}

function noActiveInvocationOutcome(): WorkingMemoryOperationOutcome {
  return {
    operation: 'clear',
    status: 'failed',
    code: 'working_memory_clear_failed',
    category: 'runtime_failure',
    retry: 'never',
  };
}

function unexpectedFailureOutcome(): WorkingMemoryOperationOutcome {
  return {
    operation: 'clear',
    status: 'failed',
    code: 'working_memory_clear_failed',
    category: 'runtime_failure',
    retry: 'never',
  };
}
