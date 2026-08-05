type PreparedStep = {
  tools?: unknown;
};

type ExecutableTool = {
  execute?: (input: unknown, context: unknown) => Promise<unknown>;
};

export async function submitOrchestratorFinalResponse(
  options: Record<string, unknown>,
  body: string,
): Promise<Record<string, unknown>> {
  const prepareStep = options.prepareStep as ((input: {
    stepNumber: number;
    steps: unknown[];
  }) => Promise<PreparedStep> | PreparedStep) | undefined;
  const prepared = prepareStep === undefined
    ? {}
    : await prepareStep({ stepNumber: 0, steps: [] });
  const tools = {
    ...recordValue(options.tools),
    ...recordValue(prepared.tools),
  };
  const tool = recordValue(tools.submitFinalResponse) as ExecutableTool;
  if (typeof tool.execute !== 'function') throw new Error('submitFinalResponse was not prepared.');
  const output = await tool.execute({ body }, {});
  return {
    text: '',
    finishReason: 'tool-calls',
    steps: [{
      text: '',
      toolCalls: [{
        toolName: 'submitFinalResponse',
        toolCallId: 'submit-final-response-1',
        args: { body },
      }],
      toolResults: [{
        toolName: 'submitFinalResponse',
        toolCallId: 'submit-final-response-1',
        result: output,
      }],
    }],
  };
}

export function rawOrchestratorTextLeak(text: string): Record<string, unknown> {
  return { text };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
