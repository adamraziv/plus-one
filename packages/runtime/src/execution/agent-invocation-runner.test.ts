import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimePolicyV1 } from '@plus-one/contracts';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { AgentInvocationRunner, RuntimePolicyRegistry } from '../index.js';
import {
  configureLogging,
  parseLogEnvelope,
  type LogEnvelopeV1,
  type LoggingHandle,
} from '../logging/index.js';

async function logRecords(
  homeDirectory: string,
  logging: LoggingHandle,
): Promise<LogEnvelopeV1[]> {
  await logging.flush();
  return (await readFile(join(homeDirectory, 'logs', 'agent.log'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => parseLogEnvelope(line))
    .filter((record): record is LogEnvelopeV1 => record !== undefined);
}

const policy: RuntimePolicyV1 = {
  identity: { policyName: 'query-maker', policyVersion: 1 },
  requiredCapabilities: ['structured_output'],
  primaryModel: 'provider/model-a', fallbackModels: ['provider/model-b'],
  maxModelSteps: 4, maxToolConcurrency: 1, maxAttempts: 2, maxModelRequestRetries: 1,
  maxProcessorRetries: 0, maxSandboxReproductions: 0,
  callDeadlineMs: 1_000, teamDeadlineMs: 5_000, endToEndDeadlineMs: 10_000,
  maxOutputBytes: 4_096,
};

describe('AgentInvocationRunner', () => {
  it('records the selected role policy and uses fallback by attempt ordinal', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-agent-'));
    const logging = configureLogging({ homeDirectory });
    const ledger = {
      startRun: vi.fn(), finishRun: vi.fn(), startAttempt: vi.fn(), finishAttempt: vi.fn(),
    };
    const generate = vi.fn().mockResolvedValue({ answer: '42' });
    const runner = new AgentInvocationRunner({
      agents: { generate } as never, policies: new RuntimePolicyRegistry({
        models: { 'provider/model-a': ['structured_output'], 'provider/model-b': ['structured_output'] },
        policies: [policy],
      }), ledger: ledger as never,
      ids: { nextRunId: () => 'run_01JNZQ4A9B8C7D6E5F4G3H2J1K' },
    });
    try {
      await runner.run({
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        role: { identity: { roleName: 'query-maker', roleVersion: 1 }, kind: 'maker',
          agentId: 'query-maker', runtimePolicy: policy.identity },
        attemptOrdinal: 2, context: { systemPrompt: 'maker',
          messages: [{ role: 'user', content: '{}' }], parentMessages: [], memoryEnabled: false,
          activeTools: [], toolHistory: [] },
        outputSchema: z.object({ answer: z.string() }), abortSignal: new AbortController().signal,
      });
      expect(generate).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'provider/model-b' }));
      expect(ledger.startRun).toHaveBeenCalledWith(expect.objectContaining({ policy }));
      expect(ledger.finishAttempt).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'succeeded' }));
      const records = await logRecords(homeDirectory, logging);
      expect(records).toContainEqual(expect.objectContaining({
        eventName: 'agent.completed',
        severityText: 'INFO',
        attributes: expect.objectContaining({
          'plus_one.household.id': 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
          'plus_one.task.id': 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
          'plus_one.run.id': 'run_01JNZQ4A9B8C7D6E5F4G3H2J1K',
          'agent.role': 'query-maker',
          'agent.model': 'provider/model-b',
          'agent.attempt.ordinal': 2,
          'duration.ms': expect.any(Number),
        }),
      }));
      expect(JSON.stringify(records)).not.toContain('systemPrompt');
    } finally {
      await logging.close();
    }
  });

  it('records cancellation and never converts exhaustion into success', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-agent-'));
    const logging = configureLogging({ homeDirectory });
    const controller = new AbortController();
    controller.abort();
    const ledger = {
      startRun: vi.fn(), finishRun: vi.fn(), startAttempt: vi.fn(), finishAttempt: vi.fn(),
    };
    const runner = new AgentInvocationRunner({
      agents: { generate: vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')) } as never,
      policies: new RuntimePolicyRegistry({
        models: { 'provider/model-a': ['structured_output'], 'provider/model-b': ['structured_output'] },
        policies: [policy],
      }), ledger: ledger as never,
      ids: { nextRunId: () => 'run_01JNZQ4A9B8C7D6E5F4G3H2J1K' },
    });
    try {
      await expect(runner.run({
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        role: { identity: { roleName: 'query-maker', roleVersion: 1 }, kind: 'maker',
          agentId: 'query-maker', runtimePolicy: policy.identity },
        attemptOrdinal: 1, context: { systemPrompt: 'maker',
          messages: [{ role: 'user', content: '{}' }], parentMessages: [], memoryEnabled: false,
          activeTools: [], toolHistory: [] },
        outputSchema: z.object({ answer: z.string() }), abortSignal: controller.signal,
      })).rejects.toMatchObject({ code: 'agent_call_cancelled' });
      expect(ledger.finishRun).toHaveBeenCalledWith(expect.any(String), 'cancelled', 'cancelled');
      const records = await logRecords(homeDirectory, logging);
      expect(records).toContainEqual(expect.objectContaining({
        eventName: 'agent.failed',
        severityText: 'ERROR',
        attributes: expect.objectContaining({
          'failure.category': 'cancelled',
          'retry.classification': 'cancelled',
        }),
      }));
      expect(JSON.stringify(records)).not.toContain('Aborted');
    } finally {
      await logging.close();
    }
  });

  it('uses WARN while another attempt remains', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-agent-'));
    const logging = configureLogging({ homeDirectory });
    const ledger = {
      startRun: vi.fn(), finishRun: vi.fn(), startAttempt: vi.fn(), finishAttempt: vi.fn(),
    };
    const runner = new AgentInvocationRunner({
      agents: { generate: vi.fn().mockRejectedValue(new Error('private provider failure')) } as never,
      policies: new RuntimePolicyRegistry({
        models: { 'provider/model-a': ['structured_output'], 'provider/model-b': ['structured_output'] },
        policies: [policy],
      }),
      ledger: ledger as never,
      ids: { nextRunId: () => 'run_01JNZQ4A9B8C7D6E5F4G3H2J1K' },
    });

    try {
      await expect(runner.run({
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        role: { identity: { roleName: 'query-maker', roleVersion: 1 }, kind: 'maker',
          agentId: 'query-maker', runtimePolicy: policy.identity },
        attemptOrdinal: 1,
        context: { systemPrompt: 'maker', messages: [{ role: 'user', content: '{}' }],
          parentMessages: [], memoryEnabled: false,
          activeTools: [], toolHistory: [] },
        outputSchema: z.object({ answer: z.string() }),
        abortSignal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'agent_model_failed' });

      const records = await logRecords(homeDirectory, logging);
      expect(records).toContainEqual(expect.objectContaining({
        eventName: 'agent.failed',
        severityText: 'WARN',
        attributes: expect.objectContaining({
          'failure.category': 'model_failure',
          'retry.classification': 'retryable',
        }),
      }));
      expect(JSON.stringify(records)).not.toContain('private provider failure');
    } finally {
      await logging.close();
    }
  });
});
