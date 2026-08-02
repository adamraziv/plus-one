import type { OutputProcessor } from '@mastra/core/processors';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { PlusOneError } from '@plus-one/contracts';

export const SubmitFinalResponseToolId = 'submitFinalResponse';

const FinalResponseSubmissionSchema = z.object({
  body: z.string().trim().min(1).max(32_000),
}).strict();

const SubmissionAcknowledgementSchema = z.object({
  accepted: z.literal(true),
}).strict();

const RESPONSE_REPAIR_MARKER = 'finalResponseRepair';
const GENERIC_REPAIR_FEEDBACK = 'Repair the response and submit it again.';

export type FinalResponseSubmission = z.infer<typeof FinalResponseSubmissionSchema>;

export interface FinalResponseSubmissionSession {
  tool: ReturnType<typeof createTool>;
  outputProcessor: OutputProcessor;
  hasSubmission(): boolean;
  requireSubmission(): FinalResponseSubmission;
  protocolViolationObserved(): boolean;
}

export function createFinalResponseSubmissionSession(input: {
  validateBody(body: string): void;
}): FinalResponseSubmissionSession {
  let submission: FinalResponseSubmission | undefined;
  let protocolViolation = false;

  const tool = createTool({
    id: SubmitFinalResponseToolId,
    description: 'Submit the complete user-facing reply. This is the only valid completion channel.',
    inputSchema: FinalResponseSubmissionSchema,
    outputSchema: SubmissionAcknowledgementSchema,
    strict: true,
    execute: async (inputData) => {
      if (submission !== undefined) throw multipleSubmissionError();
      const parsed = FinalResponseSubmissionSchema.parse(inputData);
      input.validateBody(parsed.body);
      submission = parsed;
      return { accepted: true as const };
    },
  });

  const outputProcessor: OutputProcessor = {
    id: 'orchestrator-final-response-protocol',
    processOutputStep: async ({ text, toolCalls = [], messages, abort }) => {
      const submissionCalls = toolCalls.filter(
        (call) => call.toolName === SubmitFinalResponseToolId,
      );
      if (submissionCalls.length === 0 && toolCalls.length !== 0) return messages;

      const hasTerminalText = (text?.trim().length ?? 0) !== 0;
      const validShape = submissionCalls.length === 1
        && toolCalls.length === 1
        && !hasTerminalText;
      if (!validShape) {
        protocolViolation = true;
        abort(
          'Do not return reply text or serialized tool markup. Call submitFinalResponse exactly once by itself.',
          { retry: true },
        );
      }

      const parsed = FinalResponseSubmissionSchema.safeParse(submissionCalls[0]!.args);
      if (!parsed.success) {
        protocolViolation = true;
        abort(
          'Call submitFinalResponse with exactly one non-empty body string and no extra fields.',
          { retry: true },
        );
        return messages;
      }
      try {
        input.validateBody(parsed.data.body);
      } catch (error) {
        protocolViolation = true;
        abort(safeSubmissionRepairFeedback(error), { retry: true });
      }
      return messages;
    },
  };

  return {
    tool,
    outputProcessor,
    hasSubmission: () => submission !== undefined,
    requireSubmission: () => {
      if (submission === undefined) throw responseNotSubmittedError();
      return submission;
    },
    protocolViolationObserved: () => protocolViolation,
  };
}

export function finalResponseRepairError(message: string): PlusOneError {
  return new PlusOneError({
    category: 'validation_rejected',
    code: 'orchestrator_response_rejected',
    message,
    retry: 'safe',
    receiptLookupRequired: false,
    details: { [RESPONSE_REPAIR_MARKER]: true },
  });
}

function safeSubmissionRepairFeedback(error: unknown): string {
  if (error instanceof PlusOneError
    && error.category === 'validation_rejected'
    && error.details[RESPONSE_REPAIR_MARKER] === true) {
    return error.message;
  }
  return GENERIC_REPAIR_FEEDBACK;
}

function responseNotSubmittedError(): PlusOneError {
  return new PlusOneError({
    category: 'runtime_failure',
    code: 'orchestrator_response_not_submitted',
    message: 'The orchestrator did not submit a valid final response.',
    retry: 'after_backoff',
    receiptLookupRequired: false,
  });
}

function multipleSubmissionError(): PlusOneError {
  return new PlusOneError({
    category: 'validation_rejected',
    code: 'orchestrator_response_submitted_multiple_times',
    message: 'The orchestrator submitted more than one final response.',
    retry: 'never',
    receiptLookupRequired: false,
  });
}
