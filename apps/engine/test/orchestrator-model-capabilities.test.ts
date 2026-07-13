import type { Agent } from '@mastra/core/agent';
import { describe, expect, it, vi } from 'vitest';
import { validateOrchestratorModelCapabilities } from '../src/orchestrator-model-capabilities.js';

const model = {
  id: 'openai/gpt-5',
  endpoint: 'https://llm.example.test/v1',
  apiKey: 'secret-api-key',
};

describe('orchestrator model capability validation', () => {
  it('accepts native structured output both directly and after one tool call', async () => {
    let call = 0;
    const generate = vi.fn(async (_prompt: unknown, options: unknown) => {
      void _prompt;
      void options;
      call += 1;
      if (call === 1) {
        return { object: { status: 'ok', evidence: 'direct' } };
      }

      const capabilityTool = agentOptions.tools?.capabilityProbe as unknown as {
        execute(input: unknown, context: unknown): Promise<{ receipt: string }>;
      };
      const toolResult = await capabilityTool.execute(
        { nonce: 'plus-one-orchestrator-capability-probe' },
        {},
      );
      return { object: { status: 'ok', evidence: toolResult.receipt } };
    });
    let agentOptions: ConstructorParameters<typeof Agent>[0] = {
      id: 'uninitialized',
      name: 'uninitialized',
      model: 'openai/gpt-5',
      instructions: '',
    };
    const createAgent = vi.fn((options: ConstructorParameters<typeof Agent>[0]) => {
      agentOptions = options;
      return { generate } as never;
    });

    await expect(validateOrchestratorModelCapabilities({ model }, { createAgent }))
      .resolves.toBeUndefined();

    expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({
      model: expect.objectContaining({
        id: model.id,
        url: model.endpoint,
        apiKey: model.apiKey,
      }),
      tools: { capabilityProbe: expect.any(Object) },
    }));
    expect(generate).toHaveBeenCalledTimes(2);
    const directOptions = generate.mock.calls[0]?.[1] as {
      maxSteps: number;
      toolChoice: string;
      structuredOutput: object;
    };
    expect(directOptions).toMatchObject({
      maxSteps: 1,
      toolChoice: 'auto',
      structuredOutput: { schema: expect.any(Object) },
    });
    expect(directOptions.structuredOutput).not.toHaveProperty('jsonPromptInjection');

    const delegatedOptions = generate.mock.calls[1]?.[1] as {
      maxSteps: number;
      toolChoice: string;
      prepareStep: (input: { stepNumber: number }) => { toolChoice: string };
      structuredOutput: object;
    };
    expect(delegatedOptions).toMatchObject({
      maxSteps: 2,
      toolChoice: 'required',
      structuredOutput: { schema: expect.any(Object) },
    });
    expect(delegatedOptions.prepareStep({ stepNumber: 0 })).toEqual({ toolChoice: 'required' });
    expect(delegatedOptions.prepareStep({ stepNumber: 1 })).toEqual({ toolChoice: 'none' });
    expect(delegatedOptions.structuredOutput).not.toHaveProperty('jsonPromptInjection');
  });

  it('rejects a model that returns text instead of native structured output', async () => {
    const createAgent = vi.fn(() => ({
      generate: vi.fn(async () => ({
        text: '{"status":"ok","evidence":"direct"}',
        object: undefined,
      })),
    }) as never);

    await expect(validateOrchestratorModelCapabilities({ model }, { createAgent }))
      .rejects.toMatchObject({
        category: 'validation_rejected',
        code: 'llm_orchestrator_capability_unsupported',
        retry: 'never',
        details: {
          modelId: model.id,
          capability: 'native_structured_output',
        },
      });
  });

  it('rejects a model that does not use the tool result before its final object', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ object: { status: 'ok', evidence: 'direct' } })
      .mockResolvedValueOnce({ object: { status: 'ok', evidence: 'guessed' } });
    const createAgent = vi.fn(() => ({ generate }) as never);

    await expect(validateOrchestratorModelCapabilities({ model }, { createAgent }))
      .rejects.toMatchObject({
        category: 'validation_rejected',
        code: 'llm_orchestrator_capability_unsupported',
        details: {
          modelId: model.id,
          capability: 'tool_then_structured_output',
        },
      });
  });

  it('does not expose the configured API key in capability errors', async () => {
    const createAgent = vi.fn(() => ({
      generate: vi.fn(async () => {
        throw new Error('provider rejected response_format');
      }),
    }) as never);

    const error = await validateOrchestratorModelCapabilities({ model }, { createAgent })
      .catch((caught: unknown) => caught);

    expect(JSON.stringify(error)).not.toContain(model.apiKey);
  });
});
