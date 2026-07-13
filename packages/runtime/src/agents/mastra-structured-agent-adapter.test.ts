import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentRegistry,
  MastraStructuredAgentAdapter,
  type StructuredAgentCall,
} from '../index.js';

const outputSchema = z.object({ answer: z.string() }).strict();
type Output = z.infer<typeof outputSchema>;

const call = (overrides: Partial<StructuredAgentCall<Output>> = {}): StructuredAgentCall<Output> => ({
  agentId: 'query-maker',
  modelId: 'provider/model-a',
  roleKind: 'maker',
  systemPrompt: 'maker',
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
  it('uses structuredOutput and accepts a tool-enabled result only after an active tool executes', async () => {
    const generate = vi.fn().mockResolvedValue({
      object: { answer: '42' },
      toolResults: [{ payload: { toolName: 'query_balance', result: { ok: true } } }],
    });
    const registry = new AgentRegistry();
    registry.register({ agentId: 'query-maker', modelId: 'provider/model-a',
      roleKind: 'maker', memoryEnabled: false, agent: {
        generate,
        model: { id: 'provider/model-a', url: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      } as never });
    const adapter = new MastraStructuredAgentAdapter(registry);
    await expect(adapter.generate(call({ activeTools: ['query_balance'] }))).resolves.toEqual({ answer: '42' });
    expect(generate).toHaveBeenCalledWith([{ role: 'user', content: '{}' }],
      expect.objectContaining({ structuredOutput: expect.objectContaining({
        schema: outputSchema,
        errorStrategy: 'strict',
        jsonPromptInjection: true,
        model: { id: 'provider/model-a', url: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      }), activeTools: ['query_balance'],
        maxSteps: 4, maxRetries: 0, toolCallConcurrency: 1, maxProcessorRetries: 1,
        errorProcessors: [expect.anything()],
        runId: 'run_01JNZQ4A9B8C7D6E5F4G3H2J1K', instructions: 'maker' }));
  });

  it('does not add model-step retries when the runtime policy retry budgets are zero', async () => {
    const generate = vi.fn().mockResolvedValue({ object: { answer: '42' } });
    const registry = new AgentRegistry();
    registry.register({ agentId: 'query-maker', modelId: 'provider/model-a',
      roleKind: 'maker', memoryEnabled: false, agent: { generate } as never });

    await expect(new MastraStructuredAgentAdapter(registry).generate(call({
      maxRetries: 0,
      maxProcessorRetries: 0,
    }))).resolves.toEqual({ answer: '42' });

    expect(generate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      maxRetries: 0,
      maxProcessorRetries: 0,
      errorProcessors: [],
    }));
  });

  it('accepts tool results reported inside Mastra step metadata', async () => {
    const generate = vi.fn().mockResolvedValue({
      object: { answer: '42' },
      steps: [{ toolResults: [{ payload: { toolName: 'query_balance', result: { ok: true } } }] }],
    });
    const registry = new AgentRegistry();
    registry.register({ agentId: 'query-maker', modelId: 'provider/model-a',
      roleKind: 'maker', memoryEnabled: false, agent: { generate } as never });

    await expect(new MastraStructuredAgentAdapter(registry).generate(call({
      activeTools: ['query_balance'],
    }))).resolves.toEqual({ answer: '42' });
  });

  it('rejects provider-unsafe active tool ids before making the model call', async () => {
    const generate = vi.fn();
    const registry = new AgentRegistry();
    registry.register({ agentId: 'query-maker', modelId: 'provider/model-a',
      roleKind: 'maker', memoryEnabled: false, agent: { generate } as never });

    await expect(new MastraStructuredAgentAdapter(registry).generate(call({
      activeTools: ['query.balance'],
    }))).rejects.toMatchObject({ code: 'provider_tool_id_invalid' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects tool-enabled structured output when no active tool result was produced', async () => {
    const generate = vi.fn().mockResolvedValue({
      object: { answer: '42' },
      toolCalls: [],
      toolResults: [],
      steps: [{ toolCalls: [], toolResults: [] }],
    });
    const registry = new AgentRegistry();
    registry.register({ agentId: 'query-maker', modelId: 'provider/model-a',
      roleKind: 'maker', memoryEnabled: false, agent: { generate } as never });

    await expect(new MastraStructuredAgentAdapter(registry).generate(call({
      activeTools: ['query_balance'],
    }))).rejects.toMatchObject({ code: 'tool_call_not_executed' });
  });

  it('does not retry tool-enabled provider failures without structured output', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('structured output unavailable'));
    const registry = new AgentRegistry();
    registry.register({ agentId: 'query-maker', modelId: 'provider/model-a',
      roleKind: 'maker', memoryEnabled: false, agent: { generate } as never });

    await expect(new MastraStructuredAgentAdapter(registry).generate(call({
      activeTools: ['query_balance'],
    }))).rejects.toThrow(/structured output unavailable/);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('rejects checker registrations with memory and invalid raw output', async () => {
    const registry = new AgentRegistry();
    expect(() => registry.register({ agentId: 'query-checker', modelId: 'provider/model-a',
      roleKind: 'checker', memoryEnabled: true, agent: { generate: vi.fn() } as never })).toThrow(/memory/);
    registry.register({ agentId: 'query-maker', modelId: 'provider/model-a',
      roleKind: 'maker', memoryEnabled: false,
      agent: { generate: vi.fn().mockResolvedValue({ object: '{"answer":"42"}' }) } as never });
    await expect(new MastraStructuredAgentAdapter(registry).generate(call({
      maxRetries: 0,
    }))).rejects.toThrow();
  });

  it('falls back to parsed JSON text when native structured output is unavailable for a no-tools call', async () => {
    const generate = vi.fn()
      .mockRejectedValueOnce(new Error('structured output unavailable'))
      .mockResolvedValueOnce({ text: '{"answer":"42"}' });
    const registry = new AgentRegistry();
    registry.register({ agentId: 'query-maker', modelId: 'provider/model-a',
      roleKind: 'maker', memoryEnabled: false, agent: { generate } as never });

    await expect(new MastraStructuredAgentAdapter(registry).generate(call({
      maxRetries: 0,
    }))).resolves.toEqual({ answer: '42' });

    expect(generate).toHaveBeenCalledTimes(2);
  });
});
