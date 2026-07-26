import { afterEach, describe, expect, it } from 'vitest';
import { createMastraMemoryStorage } from '@plus-one/database';
import { FlexibleWorkingMemorySchema, WorkingMemoryEntryIdSchema, type UtcInstant } from '@plus-one/contracts';
import { createOrchestratorSessionMemory } from '../../apps/engine/src/memory/orchestrator-session-memory.js';
import { workingMemoryRevision } from '../../apps/engine/src/memory/working-memory-document.js';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

const model = {
  id: 'provider/orchestrator',
  endpoint: 'https://llm.example.test/v1',
  apiKey: 'test-api-key',
};
const resourceId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const otherResourceId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2K';
const firstThreadId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H1K';
const secondThreadId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2K';
const principalRef = 'telegram:user:test';

let context: PostgresTestContext | undefined;
const closables: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (closables.length > 0) await closables.pop()?.close();
  await context?.cleanup();
  context = undefined;
});

describe('orchestrator session memory', () => {
  it('shares complete resource-scoped documents across threads and isolates resources', async () => {
    context = await createPostgresTestContext('orchestrator_working_memory_scope');
    const first = createOrchestratorSessionMemory({ connectionString: context.roleUrls.memory, model });
    closables.push(first);
    const empty = FlexibleWorkingMemorySchema.parse({ version: 1, entries: {} });
    const entryId = WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FAV');

    await expect(first.applyWorkingMemoryMutation({
      threadId: firstThreadId,
      resourceId,
      principalRef,
      basedOnRevision: workingMemoryRevision(empty),
      mutation: {
        operation: 'create',
        entryId,
        entry: { kind: 'goal', summary: 'Build a reserve.', scope: 'household', value: { goal: 'Emergency fund' } },
      },
    })).resolves.toMatchObject({ status: 'succeeded' });

    const second = createOrchestratorSessionMemory({ connectionString: context.roleUrls.memory, model });
    closables.push(second);
    await expect(second.inspectWorkingMemory({ threadId: secondThreadId, resourceId, principalRef }))
      .resolves.toMatchObject({ status: 'succeeded', inspection: { entries: [{ entryId, kind: 'goal' }] } });
    await expect(second.inspectWorkingMemory({ threadId: secondThreadId, resourceId: otherResourceId, principalRef }))
      .resolves.toMatchObject({ status: 'succeeded', inspection: { entries: [] } });
  });

  it('writes replacement documents without deep-merging the previous entry', async () => {
    context = await createPostgresTestContext('orchestrator_working_memory_replace');
    const memory = createOrchestratorSessionMemory({ connectionString: context.roleUrls.memory, model });
    closables.push(memory);
    const initial = FlexibleWorkingMemorySchema.parse({
      version: 1,
      entries: {
        wme_01ARZ3NDEKTSV4RRFFQ69G5FAV: {
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
    await memory.agentMemory.updateWorkingMemory({ threadId: firstThreadId, resourceId, workingMemory: JSON.stringify(initial) });

    const result = await memory.applyWorkingMemoryMutation({
      threadId: firstThreadId,
      resourceId,
      principalRef,
      basedOnRevision: workingMemoryRevision(initial),
      mutation: {
        operation: 'replace',
        entryId: WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
        entry: { kind: 'goal', summary: 'Buy a BMW X7.', scope: 'household', value: { goals: ['BMW X7'], timeframe: 'two years' } },
      },
    });
    expect(result).toMatchObject({ status: 'succeeded', code: 'working_memory_mutation_succeeded' });
    const inspected = await memory.inspectWorkingMemory({ threadId: firstThreadId, resourceId, principalRef });
    expect(inspected).toMatchObject({ status: 'succeeded', inspection: { entries: [{ summary: 'Buy a BMW X7.' }] } });
    if (inspected.status === 'succeeded') {
      expect(inspected.inspection.entries[0]?.value).toEqual({ goals: ['BMW X7'], timeframe: 'two years' });
    }
  });

  it('lazily migrates legacy storage and verifies the migrated readback', async () => {
    context = await createPostgresTestContext('orchestrator_working_memory_migration');
    const memory = createOrchestratorSessionMemory({ connectionString: context.roleUrls.memory, model });
    closables.push(memory);
    await memory.agentMemory.updateWorkingMemory({
      threadId: firstThreadId,
      resourceId,
      workingMemory: JSON.stringify({ goals: { car: { summary: 'Buy a BMW X5.', horizon: 'one year' } } }),
    });

    const result = await memory.inspectWorkingMemory({ threadId: firstThreadId, resourceId, principalRef });
    expect(result).toMatchObject({ status: 'succeeded', inspection: { entries: [{ kind: 'goal' }] } });
    const second = createOrchestratorSessionMemory({ connectionString: context.roleUrls.memory, model });
    closables.push(second);
    await expect(second.inspectWorkingMemory({ threadId: secondThreadId, resourceId, principalRef }))
      .resolves.toMatchObject({ status: 'succeeded', inspection: { entries: [{ kind: 'goal' }] } });
  });

  it('rejects stale approval without writing', async () => {
    context = await createPostgresTestContext('orchestrator_working_memory_stale');
    const memory = createOrchestratorSessionMemory({ connectionString: context.roleUrls.memory, model });
    closables.push(memory);
    const empty = FlexibleWorkingMemorySchema.parse({ version: 1, entries: {} });
    const firstEntryId = WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FAV');
    const secondEntryId = WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FAW');
    const inspected = await memory.inspectWorkingMemory({ threadId: firstThreadId, resourceId, principalRef });
    if (inspected.status !== 'succeeded') throw new Error('Expected inspection success');

    await expect(memory.applyWorkingMemoryMutation({
      threadId: firstThreadId,
      resourceId,
      principalRef,
      basedOnRevision: workingMemoryRevision(empty),
      mutation: { operation: 'create', entryId: firstEntryId, entry: { kind: 'goal', summary: 'Buy a BMW X5.', scope: 'household', value: { goal: 'BMW X5' } } },
    })).resolves.toMatchObject({ status: 'succeeded' });
    await expect(memory.applyWorkingMemoryMutation({
      threadId: firstThreadId,
      resourceId,
      principalRef,
      basedOnRevision: inspected.inspection.revision,
      mutation: { operation: 'create', entryId: secondEntryId, entry: { kind: 'goal', summary: 'Buy a BMW X7.', scope: 'household', value: { goal: 'BMW X7' } } },
    })).resolves.toMatchObject({ status: 'failed', code: 'working_memory_revision_stale' });
  });

  it('does not create a manual transcript while the adapter persists Working Memory', async () => {
    context = await createPostgresTestContext('orchestrator_working_memory_transcript');
    const memory = createOrchestratorSessionMemory({ connectionString: context.roleUrls.memory, model });
    closables.push(memory);
    const empty = FlexibleWorkingMemorySchema.parse({ version: 1, entries: {} });
    await memory.applyWorkingMemoryMutation({
      threadId: firstThreadId,
      resourceId,
      principalRef,
      basedOnRevision: workingMemoryRevision(empty),
      mutation: {
        operation: 'create',
        entryId: WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
        entry: { kind: 'communication_preference', summary: 'Concise replies.', scope: 'household', value: { detail: 'concise' } },
      },
    });

    const storage = createMastraMemoryStorage(context.roleUrls.memory);
    closables.push(storage as { close: () => Promise<void> });
    await storage.init();
    const store = await storage.getStore('memory');
    const messages = await store?.listMessages({ threadId: firstThreadId, page: 0, perPage: false });
    expect(messages?.messages).toEqual([]);
  });

  it('keeps member prompt views isolated across members and resources', async () => {
    context = await createPostgresTestContext('orchestrator_working_memory_member_isolation');
    const memory = createOrchestratorSessionMemory({ connectionString: context.roleUrls.memory, model });
    closables.push(memory);
    const empty = FlexibleWorkingMemorySchema.parse({ version: 1, entries: {} });
    const entryId = WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FAV');
    await expect(memory.applyWorkingMemoryMutation({
      threadId: firstThreadId,
      resourceId,
      principalRef,
      basedOnRevision: workingMemoryRevision(empty),
      mutation: {
        operation: 'create',
        entryId,
        entry: {
          kind: 'member_context',
          summary: 'Alex prefers concise replies.',
          scope: 'member',
          ownerPrincipalRef: principalRef,
          value: { preferredName: 'Alex', secret: 'private preference' },
          lifecycle: {
            createdAt: '2026-07-25T10:55:00.000Z' as UtcInstant,
            updatedAt: '2026-07-25T10:55:00.000Z' as UtcInstant,
          },
        },
      },
    })).resolves.toMatchObject({ status: 'succeeded' });

    const otherMember = await memory.readWorkingMemoryPromptContext({
      threadId: secondThreadId,
      resourceId,
      principalRef: 'telegram:user:other',
    });
    expect(otherMember).toMatchObject({ status: 'succeeded', context: { projection: { member: [] } } });
    if (otherMember.status !== 'succeeded') throw new Error('Expected other-member prompt success');
    expect(otherMember.context.prompt).not.toContain('private preference');

    const otherHousehold = await memory.readWorkingMemoryPromptContext({
      threadId: secondThreadId,
      resourceId: otherResourceId,
      principalRef: principalRef,
    });
    expect(otherHousehold).toMatchObject({ status: 'succeeded', context: { projection: { household: [], member: [] } } });
  });

  it('keeps lifecycle persistence and read-only review revision-stable across adapter recreation', async () => {
    context = await createPostgresTestContext('orchestrator_working_memory_review_readback');
    const first = createOrchestratorSessionMemory({ connectionString: context.roleUrls.memory, model });
    closables.push(first);
    const empty = FlexibleWorkingMemorySchema.parse({ version: 1, entries: {} });
    const entryId = WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FAV');
    await first.applyWorkingMemoryMutation({
      threadId: firstThreadId,
      resourceId,
      principalRef,
      basedOnRevision: workingMemoryRevision(empty),
      mutation: {
        operation: 'create',
        entryId,
        entry: { kind: 'goal', summary: 'Build a reserve.', scope: 'household', value: { goal: 'Emergency fund' } },
      },
    });
    const before = await first.inspectWorkingMemory({ threadId: firstThreadId, resourceId, principalRef });
    if (before.status !== 'succeeded') throw new Error('Expected inspection success');
    const review = await first.reviewWorkingMemory({
      threadId: firstThreadId,
      resourceId,
      principalRef,
      requestedBy: 'user',
      now: new Date('2026-07-25T10:55:00.000Z'),
    });
    expect(review).toMatchObject({ status: 'succeeded' });
    const afterReview = await first.inspectWorkingMemory({ threadId: firstThreadId, resourceId, principalRef });
    if (afterReview.status !== 'succeeded') throw new Error('Expected post-review inspection success');
    expect(afterReview.inspection.revision).toBe(before.inspection.revision);
    if (review.status !== 'succeeded') throw new Error('Expected review success');
    expect(review.report.revision).toBe(before.inspection.revision);

    const second = createOrchestratorSessionMemory({ connectionString: context.roleUrls.memory, model });
    closables.push(second);
    const recreated = await second.inspectWorkingMemory({ threadId: secondThreadId, resourceId, principalRef });
    expect(recreated).toMatchObject({ status: 'succeeded', inspection: { entries: [{ kind: 'goal' }] } });
    if (recreated.status === 'succeeded') {
      expect(recreated.document.entries[entryId]?.lifecycle).toMatchObject({
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
    }
  });
});
