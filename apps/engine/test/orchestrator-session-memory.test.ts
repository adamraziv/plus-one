import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Memory } from '@mastra/memory';
import {
  FlexibleWorkingMemorySchema,
  WorkingMemoryEntryIdSchema,
} from '@plus-one/contracts';
import {
  configureLogging,
  type LogEnvelopeV1,
} from '@plus-one/runtime';
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

function fakeMemory(
  initial: string | null = null,
  options: { persist?: boolean; readError?: unknown; writeError?: unknown } = {},
) {
  let workingMemory = initial;
  const getWorkingMemory = vi.fn(async () => {
    if (options.readError !== undefined) throw options.readError;
    return workingMemory;
  });
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

async function captureMemoryLogs(
  action: () => Promise<void>,
): Promise<LogEnvelopeV1[]> {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-memory-logs-'));
  const logging = configureLogging({ homeDirectory, level: 'DEBUG' });
  try {
    await action();
  } finally {
    await logging.close();
  }
  return (await readFile(join(homeDirectory, 'logs', 'agent.log'), 'utf8').catch(() => ''))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEnvelopeV1);
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

  it('keeps the bounded review trigger counter resource-isolated and resets it after review acknowledgement', () => {
    const memory = createMemoryPort(fakeMemory());
    expect(memory.noteWorkingMemoryMutationSuccess({ resourceId })).toEqual({ reviewDue: false });
    expect(memory.noteWorkingMemoryMutationSuccess({ resourceId })).toEqual({ reviewDue: false });
    expect(memory.noteWorkingMemoryMutationSuccess({ resourceId })).toEqual({ reviewDue: true });
    expect(memory.noteWorkingMemoryMutationSuccess({ resourceId: 'hh_other' })).toEqual({ reviewDue: false });
    memory.acknowledgeWorkingMemoryReview({ resourceId });
    expect(memory.noteWorkingMemoryMutationSuccess({ resourceId })).toEqual({ reviewDue: false });
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
          lifecycle: {
            createdAt: '2026-07-25T10:55:00.000Z',
            updatedAt: '2026-07-25T10:55:00.000Z',
          },
        },
      },
    });
  }

  describe('revision-gated Mastra Working Memory', () => {
    it('reads an authorized prompt projection without creating a same-turn inspection', async () => {
      const input = fakeMemory(JSON.stringify({
        version: 1,
        entries: {
          [memoryEntryId]: {
            kind: 'goal',
            summary: 'Buy a BMW X5.',
            scope: 'household',
            value: { goal: 'BMW X5' },
            lifecycle: {
              createdAt: '2026-07-25T10:55:00.000Z',
              updatedAt: '2026-07-25T10:55:00.000Z',
            },
          },
        },
      }));
      const memory = createMemoryPort(input);

      const result = await memory.readWorkingMemoryPromptContext({ threadId, resourceId, principalRef: memoryPrincipalRef });

      expect(result).toMatchObject({
        status: 'succeeded',
        context: { prompt: expect.stringContaining('<durable-working-memory>') },
        outcome: { operation: 'read', status: 'succeeded' },
      });
      if (result.status !== 'succeeded') throw new Error('Expected prompt context success');
      expect(result.context.prompt).toContain('Buy a BMW X5.');
      expect(result.context.prompt).not.toContain(memoryEntryId);
      expect(input.updateWorkingMemory).not.toHaveBeenCalled();
    });

    it('returns a read-only review report without writing canonical memory', async () => {
      const input = fakeMemory(JSON.stringify(flexibleMemoryDocument()));
      const memory = createMemoryPort(input);

      const result = await memory.reviewWorkingMemory({
        threadId,
        resourceId,
        principalRef: memoryPrincipalRef,
        requestedBy: 'user',
        now: new Date('2026-07-25T10:55:00.000Z'),
      });

      expect(result).toMatchObject({
        status: 'succeeded',
        report: { status: 'succeeded', findings: [] },
        outcome: { operation: 'review', status: 'succeeded' },
      });
      expect(input.updateWorkingMemory).not.toHaveBeenCalled();
    });

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

  describe('operational logging', () => {
    const privateThreadId = 'thread_1_private';
    const privateResourceId = 'resource_1_private';
    const privatePrincipalRef = 'principal_1_private';
    const privateSummary = 'private summary';
    const privateValue = 'private value';
    const prohibited = /private summary|private value|principal_1_private|resource_1_private|thread_1_private/;

    function privateDocument() {
      return FlexibleWorkingMemorySchema.parse({
        version: 1,
        entries: {
          [memoryEntryId]: {
            kind: 'goal',
            summary: privateSummary,
            scope: 'household',
            value: { secret: privateValue },
            lifecycle: {
              createdAt: '2026-07-25T10:55:00.000Z',
              updatedAt: '2026-07-25T10:55:00.000Z',
            },
          },
        },
      });
    }

    it('logs safe successful and failed reads without memory identifiers or contents', async () => {
      const records = await captureMemoryLogs(async () => {
        await createMemoryPort(fakeMemory(JSON.stringify(privateDocument())))
          .readWorkingMemoryPromptContext({
            threadId: privateThreadId,
            resourceId: privateResourceId,
            principalRef: privatePrincipalRef,
          });
        await createMemoryPort(fakeMemory(null, { readError: new Error(privateValue) }))
          .inspectWorkingMemory({
            threadId: privateThreadId,
            resourceId: privateResourceId,
            principalRef: privatePrincipalRef,
          });
      });

      expect(records).toContainEqual(expect.objectContaining({
        eventName: 'working_memory.read.completed',
        severityText: 'DEBUG',
        attributes: expect.objectContaining({
          'working_memory.operation': 'read',
          'working_memory.outcome.code': 'working_memory_prompt_context_succeeded',
        }),
      }));
      expect(records).toContainEqual(expect.objectContaining({
        eventName: 'working_memory.read.failed',
        severityText: 'ERROR',
        attributes: expect.objectContaining({
          'working_memory.operation': 'inspect',
          'failure.category': 'storage_unavailable',
          'retry.directive': 'after_backoff',
        }),
      }));
      expect(JSON.stringify(records)).not.toMatch(prohibited);
    });

    it('distinguishes completed, rejected, write-failed, and readback-failed mutations', async () => {
      const document = privateDocument();
      const replacement = {
        operation: 'replace' as const,
        entryId: memoryEntryId,
        entry: {
          kind: 'goal' as const,
          summary: privateSummary,
          scope: 'household' as const,
          value: { secret: privateValue },
        },
      };
      const missing = {
        operation: 'delete' as const,
        entryId: WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FAW'),
      };
      const emptyDocument = FlexibleWorkingMemorySchema.parse({ version: 1, entries: {} });
      const create = {
        operation: 'create' as const,
        entryId: memoryEntryId,
        entry: replacement.entry,
      };
      const call = {
        threadId: privateThreadId,
        resourceId: privateResourceId,
        principalRef: privatePrincipalRef,
        basedOnRevision: workingMemoryRevision(document),
      };

      const records = await captureMemoryLogs(async () => {
        await createMemoryPort(fakeMemory(JSON.stringify(emptyDocument)))
          .applyWorkingMemoryMutation({
            ...call,
            basedOnRevision: workingMemoryRevision(emptyDocument),
            mutation: create,
          });
        await createMemoryPort(fakeMemory(JSON.stringify(document)))
          .applyWorkingMemoryMutation({ ...call, mutation: missing });
        await createMemoryPort(fakeMemory(JSON.stringify(document), {
          writeError: new Error(privateValue),
        })).applyWorkingMemoryMutation({ ...call, mutation: replacement });
        await createMemoryPort(fakeMemory(JSON.stringify(document), { persist: false }))
          .applyWorkingMemoryMutation({ ...call, mutation: replacement });
      });

      expect(records.map((record) => [record.eventName, record.severityText])).toEqual(expect.arrayContaining([
        ['working_memory.mutation.completed', 'INFO'],
        ['working_memory.mutation.rejected', 'WARN'],
        ['working_memory.write.failed', 'ERROR'],
        ['working_memory.readback.failed', 'ERROR'],
      ]));
      expect(records).toContainEqual(expect.objectContaining({
        eventName: 'working_memory.write.failed',
        attributes: expect.objectContaining({
          'working_memory.operation': 'mutate',
          'failure.category': 'storage_unavailable',
          'retry.directive': 'after_backoff',
        }),
      }));
      expect(JSON.stringify(records)).not.toMatch(prohibited);
    });

    it('logs migration completion and failure without legacy contents', async () => {
      const legacy = JSON.stringify({
        goals: { secret: { summary: privateSummary, horizon: privateValue } },
      });
      const records = await captureMemoryLogs(async () => {
        await createMemoryPort(fakeMemory(legacy)).inspectWorkingMemory({
          threadId: privateThreadId,
          resourceId: privateResourceId,
          principalRef: privatePrincipalRef,
        });
        await createMemoryPort(fakeMemory(legacy, { writeError: new Error(privateValue) }))
          .inspectWorkingMemory({
            threadId: privateThreadId,
            resourceId: privateResourceId,
            principalRef: privatePrincipalRef,
          });
      });

      expect(records.map((record) => [record.eventName, record.severityText])).toEqual(expect.arrayContaining([
        ['working_memory.migration.completed', 'INFO'],
        ['working_memory.migration.failed', 'ERROR'],
      ]));
      expect(JSON.stringify(records)).not.toMatch(prohibited);
    });

    it('logs safe review completion and failure with request source and aggregate count', async () => {
      const records = await captureMemoryLogs(async () => {
        await createMemoryPort(fakeMemory(JSON.stringify(privateDocument()))).reviewWorkingMemory({
          threadId: privateThreadId,
          resourceId: privateResourceId,
          principalRef: privatePrincipalRef,
          requestedBy: 'scheduled_review',
          now: new Date('2026-07-25T10:55:00.000Z'),
        });
        await createMemoryPort(fakeMemory(null, { readError: new Error(privateValue) }))
          .reviewWorkingMemory({
            threadId: privateThreadId,
            resourceId: privateResourceId,
            principalRef: privatePrincipalRef,
            requestedBy: 'user',
            now: new Date('2026-07-25T10:55:00.000Z'),
          });
      });

      expect(records).toContainEqual(expect.objectContaining({
        eventName: 'working_memory.review.completed',
        severityText: 'INFO',
        attributes: expect.objectContaining({
          'request.source': 'scheduled_review',
          'working_memory.finding.count': 0,
        }),
      }));
      expect(records).toContainEqual(expect.objectContaining({
        eventName: 'working_memory.review.failed',
        severityText: 'ERROR',
        attributes: expect.objectContaining({
          'request.source': 'user',
          'failure.category': 'storage_unavailable',
        }),
      }));
      expect(JSON.stringify(records)).not.toMatch(prohibited);
    });
  });
});
