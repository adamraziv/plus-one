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
  const options = rawOptions as ContractGenerationOptions;
  const prepared = await options.prepareStep({
    stepNumber: toolResults.length === 0 ? 0 : 1,
    steps: toolResults.length === 0 ? [] : [{ toolResults }],
  });
  const execute = prepared.tools?.submitResult?.execute;
  if (execute === undefined) throw new Error('Expected task-scoped submitResult tool.');
  await execute(result);
  return { text: '', toolResults };
}

export function teamLeadPlanDraft(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const plan = value as Record<string, unknown>;
  if (!Array.isArray(plan.work)) return value;
  return {
    ...plan,
    work: plan.work.map((work) => {
      if (work === null || typeof work !== 'object' || Array.isArray(work)) return work;
      return { workCellId: (work as Record<string, unknown>).workCellId };
    }),
  };
}

export function captureContractSubmission(extraOptions: Record<string, unknown> = {}): {
  options: Record<string, unknown>;
  submitted(): unknown;
} {
  let submitted: unknown;
  return {
    options: {
      ...extraOptions,
      prepareStep: async () => ({
        tools: {
          submitResult: {
            execute: async (input: unknown) => {
              submitted = input;
              return { accepted: true };
            },
          },
        },
      }),
    },
    submitted: () => submitted,
  };
}
