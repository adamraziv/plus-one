import { createTool } from '@mastra/core/tools';
import {
  PendingInteractionSemanticDispositionSchemaV1,
  PlusOneError,
  type InboundChannelMessageV1,
  type PendingWorkingMemoryMutation,
} from '@plus-one/contracts';
import { z } from 'zod';

const SubmissionSchema = z.object({
  disposition: PendingInteractionSemanticDispositionSchemaV1,
}).strict();

const SubmissionAcknowledgementSchema = z.object({
  accepted: z.literal(true),
}).strict();

export const SubmitPendingInteractionDispositionToolId = 'submitPendingInteractionDisposition';

export interface PendingInteractionDispositionSession {
  tool: ReturnType<typeof createTool>;
  requireDisposition(): z.infer<typeof PendingInteractionSemanticDispositionSchemaV1>;
}

export function createPendingInteractionDispositionSession(): PendingInteractionDispositionSession {
  let submission: z.infer<typeof SubmissionSchema> | undefined;
  const tool = createTool({
    id: SubmitPendingInteractionDispositionToolId,
    description: 'Classify whether the message is a new request or an ambiguous reply.',
    inputSchema: SubmissionSchema,
    outputSchema: SubmissionAcknowledgementSchema,
    strict: true,
    execute: async (input) => {
      if (submission !== undefined) throw dispositionError(
        'pending_interaction_disposition_duplicate',
        'The pending interaction disposition was submitted more than once.',
      );
      submission = SubmissionSchema.parse(input);
      return { accepted: true as const };
    },
  });
  return {
    tool,
    requireDisposition: () => {
      if (submission === undefined) throw dispositionError(
        'pending_interaction_disposition_missing',
        'The pending interaction disposition was not submitted.',
      );
      return submission.disposition;
    },
  };
}

export function pendingInteractionDispositionPrompt(input: {
  message: InboundChannelMessageV1;
  pending: PendingWorkingMemoryMutation;
}): string {
  const mutation = input.pending.mutation;
  const changeSummary = mutation.operation === 'clear'
    ? 'clear all durable Working Memory'
    : mutation.operation === 'delete'
      ? 'forget one existing durable Working Memory entry'
      : `${mutation.operation} the durable Working Memory entry: ${mutation.entry.summary}`;
  return [
    'Classify only the relationship between the user message and the pending Working Memory confirmation.',
    'Return new_intent for a standalone request that can be handled without answering the pending confirmation.',
    'Return ambiguous for uncertain, mixed, or referential text that may be answering or changing the pending confirmation.',
    'Never decide whether to approve, reject, or mutate data.',
    `Pending proposed change: ${changeSummary}.`,
    `User message: ${input.message.body}`,
  ].join('\n');
}

function dispositionError(code: string, message: string): PlusOneError {
  return new PlusOneError({
    category: 'validation_rejected',
    code,
    message,
    retry: 'never',
    receiptLookupRequired: false,
    details: {},
  });
}
