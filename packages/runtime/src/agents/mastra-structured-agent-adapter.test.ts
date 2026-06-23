import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { AgentRegistry, MastraStructuredAgentAdapter } from '../index.js';

const outputSchema = z.object({ answer: z.string() }).strict();

describe('MastraStructuredAgentAdapter', () => {
  it('uses structuredOutput and reparses result.object', async () => {
    const generate = vi.fn().mockResolvedValue({ object: { answer: '42' } });
    const registry = new AgentRegistry();
    registry.register({ agentId: 'query-maker', modelId: 'provider/model-a',
      roleKind: 'maker', memoryEnabled: false, agent: { generate } as never });
    const adapter = new MastraStructuredAgentAdapter(registry);
    await expect(adapter.generate({
      agentId: 'query-maker', modelId: 'provider/model-a', roleKind: 'maker',
      systemPrompt: 'maker', messages: [{ role: 'user', content: '{}' }],
      parentMessages: [], memoryEnabled: false, activeTools: ['query.balance'], toolHistory: [],
      outputSchema, maxSteps: 4, maxRetries: 1, maxToolConcurrency: 1,
      maxProcessorRetries: 0, maxOutputBytes: 1024,
      runId: 'run_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      abortSignal: AbortSignal.timeout(1_000),
    })).resolves.toEqual({ answer: '42' });
    expect(generate).toHaveBeenCalledWith([{ role: 'user', content: '{}' }],
      expect.objectContaining({ structuredOutput: expect.objectContaining({
        schema: outputSchema, errorStrategy: 'strict', jsonPromptInjection: true,
      }), activeTools: ['query.balance'],
        maxSteps: 4, maxRetries: 1, toolCallConcurrency: 1, maxProcessorRetries: 0,
        runId: 'run_01JNZQ4A9B8C7D6E5F4G3H2J1K', instructions: 'maker' }));
  });

  it('rejects checker registrations with memory and invalid raw output', async () => {
    const registry = new AgentRegistry();
    expect(() => registry.register({ agentId: 'query-checker', modelId: 'provider/model-a',
      roleKind: 'checker', memoryEnabled: true, agent: { generate: vi.fn() } as never })).toThrow(/memory/);
    registry.register({ agentId: 'query-maker', modelId: 'provider/model-a',
      roleKind: 'maker', memoryEnabled: false,
      agent: { generate: vi.fn().mockResolvedValue({ object: '{"answer":"42"}' }) } as never });
    await expect(new MastraStructuredAgentAdapter(registry).generate({
      agentId: 'query-maker', modelId: 'provider/model-a', roleKind: 'maker',
      systemPrompt: 'maker', messages: [{ role: 'user', content: '{}' }],
      parentMessages: [], memoryEnabled: false, activeTools: [], toolHistory: [],
      outputSchema, maxSteps: 4, maxRetries: 0, maxToolConcurrency: 1,
      maxProcessorRetries: 0, maxOutputBytes: 1024,
      runId: 'run_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      abortSignal: AbortSignal.timeout(1_000),
    })).rejects.toThrow();
  });

  it('falls back to parsed JSON text when native structured output is unavailable', async () => {
    const generate = vi.fn()
      .mockRejectedValueOnce(new Error('structured output unavailable'))
      .mockResolvedValueOnce({ text: '{"answer":"42"}' });
    const registry = new AgentRegistry();
    registry.register({ agentId: 'query-maker', modelId: 'provider/model-a',
      roleKind: 'maker', memoryEnabled: false, agent: { generate } as never });

    await expect(new MastraStructuredAgentAdapter(registry).generate({
      agentId: 'query-maker', modelId: 'provider/model-a', roleKind: 'maker',
      systemPrompt: 'maker', messages: [{ role: 'user', content: '{}' }],
      parentMessages: [], memoryEnabled: false, activeTools: [], toolHistory: [],
      outputSchema, maxSteps: 4, maxRetries: 0, maxToolConcurrency: 1,
      maxProcessorRetries: 0, maxOutputBytes: 1024,
      runId: 'run_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      abortSignal: AbortSignal.timeout(1_000),
    })).resolves.toEqual({ answer: '42' });

    expect(generate).toHaveBeenCalledTimes(2);
  });
});
