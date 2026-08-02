import { describe, expect, it, vi } from 'vitest';
import {
  rawOrchestratorTextLeak,
  submitOrchestratorFinalResponse,
} from './orchestrator-agent-test-double.js';

describe('orchestrator agent test double', () => {
  it('executes the dynamically prepared final response tool', async () => {
    const execute = vi.fn(async () => ({ accepted: true }));
    const options = {
      prepareStep: async () => ({
        tools: { submitFinalResponse: { execute } },
        activeTools: ['submitFinalResponse'],
      }),
    };

    await expect(submitOrchestratorFinalResponse(options, 'Safe reply.')).resolves.toMatchObject({
      text: '',
      finishReason: 'tool-calls',
    });
    expect(execute).toHaveBeenCalledWith({ body: 'Safe reply.' }, expect.any(Object));
  });

  it('does not treat raw model text as a successful submission', () => {
    expect(rawOrchestratorTextLeak('Untrusted text.')).toEqual({ text: 'Untrusted text.' });
  });
});
