import { MessageList } from '@mastra/core/agent/message-list';
import type { OutputProcessor, ProcessOutputStepArgs } from '@mastra/core/processors';
import { describe, expect, it, vi } from 'vitest';
import {
  SubmitFinalResponseToolId,
  createFinalResponseSubmissionSession,
  finalResponseRepairError,
} from '../src/agents/orchestrator-final-response.js';

async function executeTool(tool: unknown, input: unknown): Promise<unknown> {
  const executable = tool as {
    execute?: (inputData: unknown, context: unknown) => Promise<unknown>;
  };
  if (executable.execute === undefined) throw new Error('Expected executable tool.');
  return executable.execute(input, {});
}

type OutputStepOverrides = Partial<Pick<ProcessOutputStepArgs, 'text' | 'toolCalls' | 'finishReason'>>;

async function runOutputStep(
  processor: OutputProcessor,
  overrides: OutputStepOverrides,
): Promise<unknown> {
  const processOutputStep = processor.processOutputStep;
  if (processOutputStep === undefined) throw new Error('Expected an output-step processor.');
  const abort: ProcessOutputStepArgs['abort'] = (reason, options) => {
    throw Object.assign(new Error(reason), { options });
  };
  const args: ProcessOutputStepArgs = {
    abort,
    messages: [],
    messageList: new MessageList(),
    stepNumber: 0,
    finishReason: 'stop',
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    systemMessages: [],
    steps: [],
    state: {},
    retryCount: 0,
    ...(overrides.text === undefined ? {} : { text: overrides.text }),
    ...(overrides.toolCalls === undefined ? {} : { toolCalls: overrides.toolCalls }),
    ...(overrides.finishReason === undefined ? {} : { finishReason: overrides.finishReason }),
  };
  return processOutputStep(args);
}

describe('orchestrator final response submission', () => {
  it('records one validated native submission', async () => {
    const validateBody = vi.fn<(body: string) => void>();
    const session = createFinalResponseSubmissionSession({ validateBody });

    await expect(executeTool(session.tool, { body: '  Done safely.  ' }))
      .resolves.toEqual({ accepted: true });

    expect(SubmitFinalResponseToolId).toBe('submitFinalResponse');
    expect(validateBody).toHaveBeenCalledWith('Done safely.');
    expect(session.hasSubmission()).toBe(true);
    expect(session.requireSubmission()).toEqual({ body: 'Done safely.' });
  });

  it.each([
    {
      name: 'serialized XML pseudo-tool markup',
      overrides: { text: '<invoke name="mutateWorkingMemory"><parameter name="operation">create</parameter></invoke>' },
    },
    {
      name: 'a submission plus conflicting terminal text',
      overrides: {
        text: 'The reply was also returned as text.',
        toolCalls: [{ toolName: SubmitFinalResponseToolId, toolCallId: 'call-1', args: { body: 'Reply.' } }],
      },
    },
    {
      name: 'two final response submissions',
      overrides: {
        text: '',
        toolCalls: [
          { toolName: SubmitFinalResponseToolId, toolCallId: 'call-1', args: { body: 'First.' } },
          { toolName: SubmitFinalResponseToolId, toolCallId: 'call-2', args: { body: 'Second.' } },
        ],
      },
    },
    {
      name: 'a final response mixed with a domain tool',
      overrides: {
        text: '',
        toolCalls: [
          { toolName: SubmitFinalResponseToolId, toolCallId: 'call-1', args: { body: 'Reply.' } },
          { toolName: 'delegateTeam', toolCallId: 'call-2', args: {} },
        ],
      },
    },
  ])('requests same-agent repair for $name', async ({ overrides }) => {
    const session = createFinalResponseSubmissionSession({ validateBody: vi.fn() });

    await expect(runOutputStep(session.outputProcessor, overrides))
      .rejects.toMatchObject({ options: { retry: true } });
    expect(session.protocolViolationObserved()).toBe(true);
    expect(session.hasSubmission()).toBe(false);
  });

  it('accepts validated user-facing text when no tool call is present', async () => {
    const validateBody = vi.fn<(body: string) => void>();
    const session = createFinalResponseSubmissionSession({ validateBody });

    await expect(runOutputStep(session.outputProcessor, {
      text: '  This is ordinary assistant text.  ',
    })).resolves.toBeDefined();
    expect(validateBody).toHaveBeenCalledWith('This is ordinary assistant text.');
    expect(session.protocolViolationObserved()).toBe(false);
    expect(session.requireSubmission()).toEqual({ body: 'This is ordinary assistant text.' });
  });

  it('accepts terminal text that duplicates the native submission body', async () => {
    const session = createFinalResponseSubmissionSession({ validateBody: vi.fn() });
    const submission = {
      toolName: SubmitFinalResponseToolId,
      toolCallId: 'call-1',
      args: { body: 'Reply.' },
    };

    await expect(runOutputStep(session.outputProcessor, {
      text: '  Reply.  ',
      toolCalls: [submission],
    })).resolves.toBeDefined();
    await expect(executeTool(session.tool, submission.args)).resolves.toEqual({ accepted: true });
    expect(session.protocolViolationObserved()).toBe(false);
    expect(session.requireSubmission()).toEqual({ body: 'Reply.' });
  });

  it('allows a domain-only tool step to continue the main loop', async () => {
    const session = createFinalResponseSubmissionSession({ validateBody: vi.fn() });

    await expect(runOutputStep(session.outputProcessor, {
      text: '',
      toolCalls: [{ toolName: 'delegateTeam', toolCallId: 'call-1', args: {} }],
    })).resolves.toBeDefined();
    expect(session.protocolViolationObserved()).toBe(false);
  });

  it.each([
    { name: 'empty', input: { body: '' } },
    { name: 'whitespace-only', input: { body: '   ' } },
    { name: 'oversized', input: { body: 'x'.repeat(32_001) } },
    { name: 'unknown key', input: { body: 'Reply.', extra: true } },
  ])('rejects $name input before recording it', async ({ input }) => {
    const session = createFinalResponseSubmissionSession({ validateBody: vi.fn() });

    await expect(executeTool(session.tool, input)).resolves.toMatchObject({ error: true });
    expect(session.hasSubmission()).toBe(false);
  });

  it('does not record a body when validation fails', async () => {
    const validationError = new Error('body is unsafe');
    const session = createFinalResponseSubmissionSession({
      validateBody: () => { throw validationError; },
    });

    await expect(executeTool(session.tool, { body: 'Reply.' })).rejects.toBe(validationError);
    expect(session.hasSubmission()).toBe(false);
  });

  it('keeps the first accepted body when a second execution is attempted', async () => {
    const session = createFinalResponseSubmissionSession({ validateBody: vi.fn() });

    await executeTool(session.tool, { body: 'First.' });
    await expect(executeTool(session.tool, { body: 'Second.' }))
      .rejects.toMatchObject({ code: 'orchestrator_response_submitted_multiple_times' });
    expect(session.requireSubmission()).toEqual({ body: 'First.' });
  });

  it('isolates state between sessions', async () => {
    const first = createFinalResponseSubmissionSession({ validateBody: vi.fn() });
    const second = createFinalResponseSubmissionSession({ validateBody: vi.fn() });

    await executeTool(first.tool, { body: 'First.' });
    await executeTool(second.tool, { body: 'Second.' });

    expect(first.requireSubmission()).toEqual({ body: 'First.' });
    expect(second.requireSubmission()).toEqual({ body: 'Second.' });
  });

  it('rejects when a response has not been submitted', () => {
    const session = createFinalResponseSubmissionSession({ validateBody: vi.fn() });

    expect(() => session.requireSubmission())
      .toThrowError(expect.objectContaining({ code: 'orchestrator_response_not_submitted' }));
  });

  it('exposes only marked application repair feedback', async () => {
    const session = createFinalResponseSubmissionSession({
      validateBody: () => { throw finalResponseRepairError('The response must explain the failed operation.'); },
    });

    await expect(runOutputStep(session.outputProcessor, {
      text: '',
      toolCalls: [{ toolName: SubmitFinalResponseToolId, toolCallId: 'call-1', args: { body: 'Reply.' } }],
    })).rejects.toMatchObject({
      message: 'The response must explain the failed operation.',
      options: { retry: true },
    });
  });
});
