import { inspect } from 'node:util';
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
    const shutdown = vi.fn(async () => undefined);
    const createMastra = vi.fn(() => ({ shutdown }) as never);
    let call = 0;
    let capabilityTool: {
      execute(input: unknown, context: unknown): Promise<{ receipt: string }>;
    } | undefined;
    const generate = vi.fn(async (_prompt: unknown, options: unknown) => {
      void _prompt;
      void options;
      call += 1;
      if (call === 1) {
        return { object: { status: 'ok', evidence: 'direct' } };
      }

      if (capabilityTool === undefined) throw new Error('Capability tool was not registered.');
      const toolResult = await capabilityTool.execute(
        { nonce: 'plus-one-orchestrator-capability-probe' },
        {},
      );
      return { object: { status: 'ok', evidence: toolResult.receipt } };
    });
    const createAgent = vi.fn((options: ConstructorParameters<typeof Agent>[0]) => {
      if (typeof options.tools === 'object' && options.tools !== null) {
        capabilityTool = (options.tools as Record<string, unknown>).capabilityProbe as typeof capabilityTool;
      }
      return { generate } as never;
    });

    await expect(validateOrchestratorModelCapabilities({ model }, { createAgent, createMastra }))
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
    expect(createMastra).toHaveBeenCalledWith({
      agents: { orchestratorModelCapabilityProbe: expect.any(Object) },
      logger: false,
    });
    expect(shutdown).toHaveBeenCalledOnce();
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
      structuredOutput: object;
    };
    expect(delegatedOptions).toMatchObject({
      maxSteps: 2,
      toolChoice: 'auto',
      structuredOutput: { schema: expect.any(Object) },
    });
    expect(delegatedOptions).not.toHaveProperty('prepareStep');
    expect(delegatedOptions.structuredOutput).not.toHaveProperty('jsonPromptInjection');
  });

  it('rejects a model that returns text instead of native structured output', async () => {
    const createAgent = vi.fn(() => ({
      generate: vi.fn(async () => ({
        text: '{"status":"ok","evidence":"direct"}',
        object: undefined,
      })),
    }) as never);

    await expect(validateOrchestratorModelCapabilities({
      model,
    }, {
      createAgent,
      createMastra: testMastraFactory(),
    }))
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

    await expect(validateOrchestratorModelCapabilities({
      model,
    }, {
      createAgent,
      createMastra: testMastraFactory(),
    }))
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
    const rawResponseBody = 'raw-provider-response-body';
    const createAgent = vi.fn(() => ({
      generate: vi.fn(async () => {
        throw Object.assign(
          new Error(`provider rejected ${model.apiKey}`),
          { responseBody: rawResponseBody },
        );
      }),
    }) as never);

    const error = await validateOrchestratorModelCapabilities({
      model,
    }, {
      createAgent,
      createMastra: testMastraFactory(),
    })
      .catch((caught: unknown) => caught);

    const rendered = inspect(error, { depth: 10 });
    expect(rendered).not.toContain(model.apiKey);
    expect(rendered).not.toContain(rawResponseBody);
  });
});

function testMastraFactory() {
  return vi.fn(() => ({
    shutdown: vi.fn(async () => undefined),
  }) as never);
}
