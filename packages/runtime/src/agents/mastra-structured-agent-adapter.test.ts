import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentRegistry,
  MastraStructuredAgentAdapter,
  type StructuredAgentCall,
} from '../index.js';

const outputSchema = z.object({ answer: z.string() }).strict();
type Output = z.infer<typeof outputSchema>;

interface PreparedStep {
  activeTools?: string[];
  toolChoice?: unknown;
  tools?: Record<string, { execute?: (input: unknown) => Promise<unknown> }>;
}

interface GenerationOptions {
  instructions: string;
  activeTools: string[];
  maxSteps: number;
  maxRetries: number;
  maxProcessorRetries: number;
  errorProcessors: unknown[];
  toolChoice: unknown;
  prepareStep(input: { stepNumber: number; steps: unknown[] }): PreparedStep | Promise<PreparedStep>;
}

const call = (overrides: Partial<StructuredAgentCall<Output>> = {}): StructuredAgentCall<Output> => ({
  agentId: 'query-maker',
  modelId: 'provider/model-a',
  roleKind: 'maker',
  systemPrompt: 'Return the checked answer.',
  messages: [{ role: 'user', content: '{}' }],
  parentMessages: [],
  memoryEnabled: false,
  activeTools: [],
  toolHistory: [],
  outputSchema,
  maxSteps: 4,
  maxRetries: 1,
  maxToolConcurrency: 1,
  maxProcessorRetries: 0,
  maxOutputBytes: 1024,
  runId: 'run_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  abortSignal: AbortSignal.timeout(1_000),
  ...overrides,
});

describe('MastraStructuredAgentAdapter', () => {
  it('completes a no-domain-tool call through task-scoped submitResult', async () => {
    const generate = vi.fn(async (_messages: unknown, rawOptions: unknown) => {
      const options = rawOptions as GenerationOptions;
      expect(options).not.toHaveProperty('structuredOutput');
      expect(options).toMatchObject({
        activeTools: [],
        maxSteps: 1,
        maxRetries: 0,
        maxProcessorRetries: 1,
        errorProcessors: [expect.anything()],
        toolChoice: 'auto',
      });
      expect(options.instructions).toContain('submitResult');
      const prepared = await options.prepareStep({ stepNumber: 0, steps: [] });
      expect(prepared.activeTools).toEqual(['submitResult']);
      expect(prepared.toolChoice).toBe('auto');
      await submitTool(prepared).execute?.({ answer: '42' });
      return { text: 'Untrusted free text is not the contractual result.' };
    });
    const adapter = adapterWith(generate);

    await expect(adapter.generate(call())).resolves.toEqual({ answer: '42' });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('uses a domain tool in the first phase and submitResult in the second phase', async () => {
    const generate = vi.fn(async (_messages: unknown, rawOptions: unknown) => {
      const options = rawOptions as GenerationOptions;
      expect(options).not.toHaveProperty('structuredOutput');
      expect(options).toMatchObject({
        activeTools: ['query_balance'],
        maxSteps: 2,
        toolChoice: 'auto',
      });
      const domainPhase = await options.prepareStep({ stepNumber: 0, steps: [] });
      expect(domainPhase).toMatchObject({ activeTools: ['query_balance'], toolChoice: 'auto' });
      expect(domainPhase.tools).toBeUndefined();

      const submissionPhase = await options.prepareStep({
        stepNumber: 1,
        steps: [{ toolResults: [{ payload: { toolName: 'query_balance', result: { balance: 42 } } }] }],
      });
      expect(submissionPhase.activeTools).toEqual(['submitResult']);
      expect(submissionPhase.toolChoice).toBe('auto');
      await submitTool(submissionPhase).execute?.({ answer: '42' });
      return {
        text: '',
        steps: [{ toolResults: [{ payload: { toolName: 'query_balance', result: { balance: 42 } } }] }],
      };
    });
    const adapter = adapterWith(generate);

    await expect(adapter.generate(call({ activeTools: ['query_balance'] })))
      .resolves.toEqual({ answer: '42' });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('accepts matching domain tool results reported at the result top level', async () => {
    const generate = vi.fn(async (_messages: unknown, rawOptions: unknown) => {
      const options = rawOptions as GenerationOptions;
      const submissionPhase = await options.prepareStep({ stepNumber: 1, steps: [] });
      await submitTool(submissionPhase).execute?.({ answer: '42' });
      return { toolResults: [{ toolName: 'query_balance', result: { balance: 42 } }] };
    });

    await expect(adapterWith(generate).generate(call({ activeTools: ['query_balance'] })))
      .resolves.toEqual({ answer: '42' });
  });

  it('rejects a call that does not submit a contractual result', async () => {
    const generate = vi.fn().mockResolvedValue({ text: '{"answer":"42"}' });

    await expect(adapterWith(generate).generate(call()))
      .rejects.toMatchObject({ code: 'structured_result_not_submitted' });
  });

  it('rejects duplicate result submissions', async () => {
    const generate = vi.fn(async (_messages: unknown, rawOptions: unknown) => {
      const options = rawOptions as GenerationOptions;
      const prepared = await options.prepareStep({ stepNumber: 0, steps: [] });
      const tool = submitTool(prepared);
      await tool.execute?.({ answer: '42' });
      await tool.execute?.({ answer: '43' });
      return { text: '' };
    });

    await expect(adapterWith(generate).generate(call()))
      .rejects.toMatchObject({ code: 'structured_result_submitted_multiple_times' });
  });

  it('rejects schema-invalid submitResult arguments', async () => {
    const generate = vi.fn(async (_messages: unknown, rawOptions: unknown) => {
      const options = rawOptions as GenerationOptions;
      const prepared = await options.prepareStep({ stepNumber: 0, steps: [] });
      const result = await submitTool(prepared).execute?.({ answer: 42 });
      expect(result).toMatchObject({ error: true });
      return { text: '' };
    });

    await expect(adapterWith(generate).generate(call()))
      .rejects.toMatchObject({ code: 'structured_result_not_submitted' });
  });

  it('rejects a valid submission over the output byte limit', async () => {
    const generate = vi.fn(async (_messages: unknown, rawOptions: unknown) => {
      const options = rawOptions as GenerationOptions;
      const prepared = await options.prepareStep({ stepNumber: 0, steps: [] });
      await submitTool(prepared).execute?.({ answer: 'a'.repeat(100) });
      return { text: '' };
    });

    await expect(adapterWith(generate).generate(call({ maxOutputBytes: 16 })))
      .rejects.toMatchObject({ code: 'structured_output_too_large' });
  });

  it('rejects a tool-enabled call when no approved domain tool executed', async () => {
    const generate = vi.fn(async (_messages: unknown, rawOptions: unknown) => {
      const options = rawOptions as GenerationOptions;
      const prepared = await options.prepareStep({ stepNumber: 1, steps: [] });
      await submitTool(prepared).execute?.({ answer: '42' });
      return { toolResults: [], steps: [{ toolResults: [] }] };
    });

    await expect(adapterWith(generate).generate(call({ activeTools: ['query_balance'] })))
      .rejects.toMatchObject({ code: 'tool_call_not_executed' });
  });

  it('rejects a domain-tool call when the model-step budget cannot fit both phases', async () => {
    const generate = vi.fn();

    await expect(adapterWith(generate).generate(call({
      activeTools: ['query_balance'],
      maxSteps: 1,
    }))).rejects.toMatchObject({ code: 'model_step_budget_too_small' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects provider-unsafe active tool ids before making the model call', async () => {
    const generate = vi.fn();

    await expect(adapterWith(generate).generate(call({ activeTools: ['query.balance'] })))
      .rejects.toMatchObject({ code: 'provider_tool_id_invalid' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('does not rerun the whole generation after a provider failure', async () => {
    const generate = vi.fn(async (_messages: unknown, rawOptions: unknown) => {
      const options = rawOptions as GenerationOptions;
      await options.prepareStep({ stepNumber: 0, steps: [] });
      throw new Error('Inference capacity queue is full');
    });

    await expect(adapterWith(generate).generate(call({ activeTools: ['query_balance'] })))
      .rejects.toThrow('Inference capacity queue is full');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('does not add model-step retries when both runtime retry budgets are zero', async () => {
    const generate = vi.fn(async (_messages: unknown, rawOptions: unknown) => {
      const options = rawOptions as GenerationOptions;
      expect(options).toMatchObject({
        maxRetries: 0,
        maxProcessorRetries: 0,
        errorProcessors: [],
      });
      const prepared = await options.prepareStep({ stepNumber: 0, steps: [] });
      await submitTool(prepared).execute?.({ answer: '42' });
      return { text: '' };
    });

    await expect(adapterWith(generate).generate(call({
      maxRetries: 0,
      maxProcessorRetries: 0,
    }))).resolves.toEqual({ answer: '42' });
  });

  it('keeps contractual messages, memory, and checker registration isolated', async () => {
    const generate = vi.fn();
    const registry = registryWith(generate);

    await expect(new MastraStructuredAgentAdapter(registry).generate(call({
      parentMessages: [{ role: 'user', content: 'inherited' }] as never,
    }))).rejects.toMatchObject({ code: 'contractual_context_not_isolated' });
    expect(generate).not.toHaveBeenCalled();

    expect(() => registry.register({
      agentId: 'query-checker',
      modelId: 'provider/model-a',
      roleKind: 'checker',
      memoryEnabled: true,
      agent: { generate } as never,
    })).toThrow(/memory/i);
  });
});

function adapterWith(generate: (...args: never[]) => unknown): MastraStructuredAgentAdapter {
  return new MastraStructuredAgentAdapter(registryWith(generate));
}

function registryWith(generate: (...args: never[]) => unknown): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register({
    agentId: 'query-maker',
    modelId: 'provider/model-a',
    roleKind: 'maker',
    memoryEnabled: false,
    agent: { generate } as never,
  });
  return registry;
}

function submitTool(prepared: PreparedStep): { execute?: (input: unknown) => Promise<unknown> } {
  const tool = prepared.tools?.submitResult;
  if (tool === undefined) throw new Error('Expected task-scoped submitResult tool.');
  return tool;
}
