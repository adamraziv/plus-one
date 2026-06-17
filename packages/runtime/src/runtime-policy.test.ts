import { describe, expect, it } from 'vitest';
import { RuntimePolicyRegistry } from './runtime-policy.js';

describe('RuntimePolicyRegistry', () => {
  it('returns only policies whose primary and fallback models satisfy required capabilities', () => {
    const registry = new RuntimePolicyRegistry({
      models: {
        'provider/model-a': ['structured_output', 'tool_calling'],
        'provider/model-b': ['structured_output', 'tool_calling', 'long_context'],
      },
      policies: [
        {
          identity: { policyName: 'query-maker', policyVersion: 1 },
          requiredCapabilities: ['structured_output', 'tool_calling'],
          primaryModel: 'provider/model-a',
          fallbackModels: ['provider/model-b'],
          maxModelSteps: 8,
          maxToolConcurrency: 2,
          maxAttempts: 2,
          maxModelRequestRetries: 1,
          maxProcessorRetries: 0,
          maxSandboxReproductions: 0,
          callDeadlineMs: 30_000,
          teamDeadlineMs: 120_000,
          endToEndDeadlineMs: 300_000,
          maxOutputBytes: 131_072,
        },
      ],
    });

    expect(registry.resolve({ policyName: 'query-maker', policyVersion: 1 }).primaryModel).toBe(
      'provider/model-a',
    );
  });

  it('rejects an incapable fallback instead of assuming provider interchangeability', () => {
    expect(
      () =>
        new RuntimePolicyRegistry({
          models: {
            'provider/model-a': ['structured_output'],
            'provider/model-b': ['tool_calling'],
          },
          policies: [
            {
              identity: { policyName: 'maker', policyVersion: 1 },
              requiredCapabilities: ['structured_output'],
              primaryModel: 'provider/model-a',
              fallbackModels: ['provider/model-b'],
              maxModelSteps: 4,
              maxToolConcurrency: 1,
              maxAttempts: 1,
              maxModelRequestRetries: 0,
              maxProcessorRetries: 0,
              maxSandboxReproductions: 0,
              callDeadlineMs: 10_000,
              teamDeadlineMs: 20_000,
              endToEndDeadlineMs: 30_000,
              maxOutputBytes: 65_536,
            },
          ],
        }),
    ).toThrow(/provider\/model-b.*structured_output/);
  });
});
