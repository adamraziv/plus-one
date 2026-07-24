import { describe, expect, it, vi } from 'vitest';
import type { InboundChannelMessageV1 } from '@plus-one/contracts';
import type {
  OrchestratorSessionMemoryPort,
  WorkingMemoryOperationOutcome,
} from '../memory/orchestrator-session-memory.js';
import { createForgetEverythingTool } from './working-memory.js';

const message = {
  conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  speaker: { principalRef: 'telegram:user:1' },
} as InboundChannelMessageV1;

function activeInvocation() {
  return {
    message,
    signal: new AbortController().signal,
  };
}

async function executeTool(tool: ReturnType<typeof createForgetEverythingTool>, input: unknown = {}) {
  return tool.execute?.(input as never, {} as never);
}

describe('createForgetEverythingTool', () => {
  it('clears only the authenticated resource and accepts no model-controlled scope', async () => {
    const outcome: WorkingMemoryOperationOutcome = {
      operation: 'clear',
      status: 'succeeded',
      code: 'working_memory_clear_succeeded',
    };
    const clearWorkingMemory = vi.fn(async () => outcome);
    const memory = { clearWorkingMemory } as unknown as OrchestratorSessionMemoryPort;
    const tool = createForgetEverythingTool({
      memory,
      getActiveInvocation: () => activeInvocation(),
    });

    const result = await executeTool(tool);

    expect(result).toEqual(outcome);
    expect(clearWorkingMemory).toHaveBeenCalledWith({
      threadId: message.conversationId,
      resourceId: message.householdId,
    });
    await expect(executeTool(tool, {
      resourceId: 'other-household',
      threadId: 'other-thread',
    })).resolves.toMatchObject({ error: true });
    expect(clearWorkingMemory).toHaveBeenCalledOnce();
  });

  it('returns a typed failure without exposing raw storage details', async () => {
    const outcome: WorkingMemoryOperationOutcome = {
      operation: 'clear',
      status: 'failed',
      code: 'working_memory_clear_failed',
      category: 'storage_unavailable',
      retry: 'after_backoff',
    };
    const clearWorkingMemory = vi.fn(async () => outcome);
    const memory = { clearWorkingMemory } as unknown as OrchestratorSessionMemoryPort;
    const tool = createForgetEverythingTool({
      memory,
      getActiveInvocation: () => activeInvocation(),
    });

    const result = await executeTool(tool);

    expect(result).toEqual(outcome);
    expect(JSON.stringify(result)).not.toContain('permission denied');
    expect(JSON.stringify(result)).not.toContain('stack');
  });

  it('returns a safe typed failure when there is no active invocation', async () => {
    const clearWorkingMemory = vi.fn();
    const memory = { clearWorkingMemory } as unknown as OrchestratorSessionMemoryPort;
    const tool = createForgetEverythingTool({
      memory,
      getActiveInvocation: () => undefined,
    });

    await expect(executeTool(tool)).resolves.toMatchObject({
      operation: 'clear',
      status: 'failed',
      code: 'working_memory_clear_failed',
    });
    expect(clearWorkingMemory).not.toHaveBeenCalled();
  });
});
