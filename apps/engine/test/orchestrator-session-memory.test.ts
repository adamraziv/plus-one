import { describe, expect, it, vi } from 'vitest';
import { Memory } from '@mastra/memory';
import {
  FlexibleWorkingMemorySchema,
  WorkingMemoryEntryIdSchema,
} from '@plus-one/contracts';
import {
  createOrchestratorSessionMemory,
  orchestratorSessionMemoryOptions,
  type OrchestratorSessionMemoryPort,
} from '../src/memory/orchestrator-session-memory.js';
import { workingMemoryRevision } from '../src/memory/working-memory-document.js';

const model = {
  id: 'openai/gpt-4.1-mini',
  endpoint: 'https://llm.example.test/v1',
  apiKey: 'test-api-key',
};
const threadId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const resourceId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';

function fakeMemory(initial: string | null = null, options: { persist?: boolean; writeError?: unknown } = {}) {
  let workingMemory = initial;
  const getWorkingMemory = vi.fn(async () => workingMemory);
  const updateWorkingMemory = vi.fn(async (input: { workingMemory: string }) => {
    if (options.writeError !== undefined) throw options.writeError;
    if (options.persist !== false) workingMemory = input.workingMemory;
  });
  return {
    memory: { getWorkingMemory, updateWorkingMemory } as unknown as Memory,
    getWorkingMemory,
    updateWorkingMemory,
  };
}

function createMemoryPort(input: ReturnType<typeof fakeMemory>): OrchestratorSessionMemoryPort {
  return createOrchestratorSessionMemory({ memory: input.memory });
}

describe('orchestratorSessionMemoryOptions', () => {
  it('enables read-only resource-scoped Working Memory and thread-scoped OM', () => {
    expect(orchestratorSessionMemoryOptions(model)).toMatchObject({
      lastMessages: 20,
      semanticRecall: false,
      workingMemory: {
        enabled: true,
        scope: 'resource',
        agentManaged: false,
        schema: FlexibleWorkingMemorySchema,
      },
      observationalMemory: {
        model: {
          id: model.id,
          url: model.endpoint,
          apiKey: model.apiKey,
        },
        scope: 'thread',
        retrieval: { scope: 'thread' },
        observation: { manageWorkingMemory: false },
      },
    });
  });
});

describe('OrchestratorSessionMemory', () => {
  it('closes an injected memory boundary idempotently', async () => {
    const input = fakeMemory();
    const close = vi.fn(async () => undefined);
    const memory = createOrchestratorSessionMemory({ memory: input.memory, close });

    await memory.close();
    await memory.close();

    expect(close).toHaveBeenCalledOnce();
  });

  const memoryEntryId = WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FAV');
  const memoryPrincipalRef = 'telegram:user:1';

  function flexibleMemoryDocument() {
    return FlexibleWorkingMemorySchema.parse({
      version: 1,
      entries: {
        [memoryEntryId]: {
          kind: 'goal',
          summary: 'Buy a BMW X5.',
          scope: 'household',
          value: { goal: 'BMW X5', timeframe: 'one year' },
        },
      },
    });
  }

  describe('revision-gated Mastra Working Memory', () => {
    it('inspects and lazily migrates a legacy document through Mastra with authorized visibility', async () => {
      const input = fakeMemory(JSON.stringify({
        goals: { car: { summary: 'Buy a BMW X5.', horizon: 'one year' } },
        members: {
          [memoryPrincipalRef]: { preferredName: 'Alex' },
          'telegram:user:2': { preferredName: 'Sam' },
        },
      }));
      const memory = createMemoryPort(input);

      const result = await memory.inspectWorkingMemory({ threadId, resourceId, principalRef: memoryPrincipalRef });

      expect(result).toMatchObject({ status: 'succeeded', inspection: { entries: expect.any(Array) } });
      if (result.status !== 'succeeded') throw new Error('Expected inspection success');
      expect(result.inspection.entries).toHaveLength(2);
      expect(result.inspection.entries.map((entry) => entry.kind)).toEqual(['goal', 'member_context']);
      expect(input.updateWorkingMemory).toHaveBeenCalledOnce();
      expect(JSON.parse(input.updateWorkingMemory.mock.calls[0]![0].workingMemory)).toMatchObject({
        version: 1,
        entries: expect.any(Object),
      });
    });

    it('rejects a stale mutation before calling Mastra update', async () => {
      const input = fakeMemory(JSON.stringify({ version: 1, entries: {} }));
      const memory = createMemoryPort(input);
      const mutation = {
        operation: 'create' as const,
        entryId: memoryEntryId,
        entry: { kind: 'goal' as const, summary: 'Buy a BMW X5.', scope: 'household' as const, value: { goal: 'BMW X5' } },
      };

      const result = await memory.applyWorkingMemoryMutation({
        threadId,
        resourceId,
        principalRef: memoryPrincipalRef,
        basedOnRevision: 'b'.repeat(64),
        mutation,
      });

      expect(result).toMatchObject({
        status: 'failed',
        code: 'working_memory_revision_stale',
        category: 'serialization_conflict',
      });
      expect(input.updateWorkingMemory).not.toHaveBeenCalled();
    });

    it('writes complete documents and replaces entries instead of deep-merging old values', async () => {
      const initial = flexibleMemoryDocument();
      const input = fakeMemory(JSON.stringify(initial));
      const memory = createMemoryPort(input);
      const mutation = {
        operation: 'replace' as const,
        entryId: memoryEntryId,
        entry: {
          kind: 'goal' as const,
          summary: 'Buy a BMW X7.',
          scope: 'household' as const,
          value: { goals: ['BMW X7'], timeframe: 'two years' },
        },
      };

      const result = await memory.applyWorkingMemoryMutation({
        threadId,
        resourceId,
        principalRef: memoryPrincipalRef,
        basedOnRevision: workingMemoryRevision(initial),
        mutation,
      });

      expect(result).toMatchObject({ status: 'succeeded', code: 'working_memory_mutation_succeeded' });
      expect(input.updateWorkingMemory).toHaveBeenCalledOnce();
      const persisted = JSON.parse(input.updateWorkingMemory.mock.calls[0]![0].workingMemory) as { entries: Record<string, { value: unknown }> };
      expect(persisted.entries[memoryEntryId]?.value).toEqual({ goals: ['BMW X7'], timeframe: 'two years' });
      expect(persisted.entries[memoryEntryId]?.value).not.toHaveProperty('goal');
    });

    it('does not write for validation or authorization failures', async () => {
      const initial = flexibleMemoryDocument();
      const input = fakeMemory(JSON.stringify(initial));
      const memory = createMemoryPort(input);
      const mutation = {
        operation: 'delete' as const,
        entryId: WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FAW'),
      };

      const result = await memory.applyWorkingMemoryMutation({
        threadId,
        resourceId,
        principalRef: memoryPrincipalRef,
        basedOnRevision: workingMemoryRevision(initial),
        mutation,
      });

      expect(result).toMatchObject({ status: 'failed', code: 'working_memory_entry_not_found' });
      expect(input.updateWorkingMemory).not.toHaveBeenCalled();
    });

    it('maps Mastra write errors to storage failure and readback mismatches to a non-success outcome', async () => {
      const initial = flexibleMemoryDocument();
      const mutation = {
        operation: 'create' as const,
        entryId: WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FAW'),
        entry: { kind: 'goal' as const, summary: 'Save more.', scope: 'household' as const, value: { goal: 'save' } },
      };
      const writeFailure = fakeMemory(JSON.stringify(initial), { writeError: new Error('database unavailable') });
      const writeMemory = createMemoryPort(writeFailure);
      await expect(writeMemory.applyWorkingMemoryMutation({
        threadId,
        resourceId,
        principalRef: memoryPrincipalRef,
        basedOnRevision: workingMemoryRevision(initial),
        mutation,
      })).resolves.toMatchObject({ status: 'failed', code: 'working_memory_write_failed', category: 'storage_unavailable' });

      const mismatch = fakeMemory(JSON.stringify(initial), { persist: false });
      const mismatchMemory = createMemoryPort(mismatch);
      await expect(mismatchMemory.applyWorkingMemoryMutation({
        threadId,
        resourceId,
        principalRef: memoryPrincipalRef,
        basedOnRevision: workingMemoryRevision(initial),
        mutation,
      })).resolves.toMatchObject({ status: 'failed', code: 'working_memory_readback_mismatch', category: 'readback_mismatch' });
    });

    it('validates a pending mutation without writing and serializes resource mutations', async () => {
      const initial = FlexibleWorkingMemorySchema.parse({ version: 1, entries: {} });
      const input = fakeMemory(JSON.stringify(initial));
      const memory = createMemoryPort(input);
      const mutation = {
        operation: 'create' as const,
        entryId: memoryEntryId,
        entry: { kind: 'goal' as const, summary: 'Buy a BMW X5.', scope: 'household' as const, value: { goal: 'BMW X5' } },
      };
      await expect(memory.validateWorkingMemoryMutation({
        threadId,
        resourceId,
        principalRef: memoryPrincipalRef,
        basedOnRevision: workingMemoryRevision(initial),
        mutation,
      })).resolves.toMatchObject({ status: 'succeeded', code: 'working_memory_mutation_validated' });
      expect(input.updateWorkingMemory).not.toHaveBeenCalled();

      let releaseFirst!: () => void;
      const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let calls = 0;
      input.getWorkingMemory.mockImplementation(async () => {
        calls += 1;
        if (calls === 1) await firstBlocked;
        return JSON.stringify(initial);
      });
      const first = memory.inspectWorkingMemory({ threadId, resourceId, principalRef: memoryPrincipalRef });
      const second = memory.inspectWorkingMemory({ threadId, resourceId, principalRef: memoryPrincipalRef });
      await Promise.resolve();
      expect(calls).toBe(1);
      releaseFirst();
      await Promise.all([first, second]);
      expect(calls).toBe(2);
    });
  });
});
