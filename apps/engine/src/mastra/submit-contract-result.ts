interface PreparedStep {
  tools?: Record<string, { execute?: (input: unknown) => Promise<unknown> }>;
}

interface ContractGenerationOptions {
  prepareStep(input: { stepNumber: number; steps: unknown[] }): PreparedStep | Promise<PreparedStep>;
}

export async function submitContractResult(
  rawOptions: unknown,
  result: unknown,
  toolResults: unknown[] = [],
): Promise<{ text: string; toolResults: unknown[] }> {
  const options = rawOptions as Partial<ContractGenerationOptions>;
  if (options.prepareStep === undefined) {
    throw new TypeError('Contract result submission requires a task-scoped prepareStep function.');
  }
  const prepared = await options.prepareStep({
    stepNumber: toolResults.length === 0 ? 0 : 1,
    steps: toolResults.length === 0 ? [] : [{ toolResults }],
  });
  const execute = prepared.tools?.submitResult?.execute;
  if (execute === undefined) throw new TypeError('Task-scoped submitResult tool is unavailable.');
  await execute(result);
  return { text: '', toolResults };
}
