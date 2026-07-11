import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimePolicyV1 } from '@plus-one/contracts';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { AgentInvocationRunner, RuntimePolicyRegistry } from '../index.js';
import { configureLogging } from '../logging/index.js';

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
      const agentLog = await readFile(join(homeDirectory, 'logs', 'agent.log'), 'utf8');
      expect(agentLog).toContain('agent.started');
      expect(agentLog).toContain('agent.completed');
      expect(agentLog).toContain('householdId=hh_01JNZQ4A9B8C7D6E5F4G3H2J1K');
      expect(agentLog).toContain('taskId=task_01JNZQ4A9B8C7D6E5F4G3H2J1K');
      expect(agentLog).toContain('runId=run_01JNZQ4A9B8C7D6E5F4G3H2J1K');
      expect(agentLog).toContain('role=query-maker');
      expect(agentLog).toContain('model=provider/model-b');
      expect(agentLog).toContain('attemptOrdinal=2');
      expect(agentLog).toContain('durationMs=');
      expect(agentLog).not.toContain('systemPrompt');
    } finally {
      logging.close();
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
      const agentLog = await readFile(join(homeDirectory, 'logs', 'agent.log'), 'utf8');
      expect(agentLog).toContain('agent.failed');
      expect(agentLog).toContain('failureCategory=cancelled');
      expect(agentLog).not.toContain('Aborted');
    } finally {
      logging.close();
    }
  });
});
