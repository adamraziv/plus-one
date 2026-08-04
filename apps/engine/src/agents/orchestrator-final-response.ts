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
      if (submissionCalls.length === 0) {
        if (toolCalls.length !== 0) return messages;
        const parsedText = FinalResponseSubmissionSchema.safeParse({ body: text });
        if (!parsedText.success || containsSerializedToolMarkup(parsedText.data.body)) {
          protocolViolation = true;
          abort(
            'Do not return serialized tool markup. Call submitFinalResponse or return only the user-facing reply.',
            { retry: true },
          );
          return messages;
        }
        try {
          input.validateBody(parsedText.data.body);
        } catch (error) {
          protocolViolation = true;
          abort(safeSubmissionRepairFeedback(error), { retry: true });
        }
        submission = parsedText.data;
        return messages;
      }

      const validShape = submissionCalls.length === 1
        && toolCalls.length === 1;
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
      const terminalText = text?.trim();
      if (terminalText !== undefined
        && terminalText.length !== 0
        && terminalText !== parsed.data.body) {
        protocolViolation = true;
        abort(
          'Do not return reply text that conflicts with submitFinalResponse.',
          { retry: true },
        );
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
      if (submission === undefined) throw orchestratorResponseNotSubmittedError();
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

function containsSerializedToolMarkup(value: string): boolean {
  const normalized = value.toLowerCase();
  const tags = new Set(['invoke', 'parameter', 'tool_call', 'tool-call', 'function_call', 'function-call']);
  let index = normalized.indexOf('<');
  while (index !== -1) {
    let cursor = index + 1;
    while (isAsciiWhitespace(normalized[cursor])) cursor += 1;
    if (normalized[cursor] === '/') cursor += 1;
    while (isAsciiWhitespace(normalized[cursor])) cursor += 1;
    const tokenStart = cursor;
    while (isAsciiTagCharacter(normalized[cursor])) cursor += 1;
    if (tags.has(normalized.slice(tokenStart, cursor))) return true;
    index = normalized.indexOf('<', index + 1);
  }
  return false;
}

function isAsciiWhitespace(value: string | undefined): boolean {
  return value === ' ' || value === '\n' || value === '\r' || value === '\t';
}

function isAsciiTagCharacter(value: string | undefined): boolean {
  if (value === undefined) return false;
  const code = value.codePointAt(0);
  return value === '_' || value === '-'
    || (code !== undefined && ((code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)));
}

export function orchestratorResponseNotSubmittedError(): PlusOneError {
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
