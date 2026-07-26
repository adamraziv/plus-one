import { describe, expect, it } from 'vitest';
import {
  FlexibleWorkingMemorySchema,
  WorkingMemoryEntryIdSchema,
  WorkingMemoryProposalIdSchema,
  type FlexibleWorkingMemory,
  type ResolvedWorkingMemoryMutation,
} from '@plus-one/contracts';
import {
  applyResolvedWorkingMemoryMutation,
  decodeStoredWorkingMemory,
  proposalExpired,
  resolveWorkingMemoryMutation,
  verifyWorkingMemoryReadback,
  visibleWorkingMemoryEntries,
  workingMemoryRevision,
  type WorkingMemoryIdGenerator,
} from '../src/memory/working-memory-document.js';

const principalRef = 'telegram:user:1';
const otherPrincipalRef = 'telegram:user:2';
const goalId = WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FAV');
const memberId = WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FAW');
const otherMemberId = WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FAX');
const nextId = WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FAY');
const nextProposalId = WorkingMemoryProposalIdSchema.parse('wmproposal_01ARZ3NDEKTSV4RRFFQ69G5FAV');

function idGenerator(overrides: Partial<WorkingMemoryIdGenerator> = {}): WorkingMemoryIdGenerator {
  const generatedEntryIds = [
    nextId,
    WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FAZ'),
    WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FB0'),
    WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FB1'),
    WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FB2'),
    WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FB3'),
    WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FB4'),
  ];
  let entryIndex = 0;
  return {
    nextEntryId: () => generatedEntryIds[entryIndex++] ?? nextId,
    nextProposalId: () => nextProposalId,
    ...overrides,
  };
}

function documentFixture(): FlexibleWorkingMemory {
  return FlexibleWorkingMemorySchema.parse({
    version: 1,
    entries: {
      [goalId]: {
        kind: 'goal',
        summary: 'Buy a BMW X5 within one year.',
        scope: 'household',
        value: { goal: 'BMW X5', timeframe: 'one year' },
      },
      [memberId]: {
        kind: 'member_context',
        summary: 'Alex prefers concise updates.',
        scope: 'member',
        ownerPrincipalRef: principalRef,
        value: { preferredName: 'Alex', detail: 'concise' },
      },
      [otherMemberId]: {
        kind: 'member_context',
        summary: 'Sam prefers warm updates.',
        scope: 'member',
        ownerPrincipalRef: otherPrincipalRef,
        value: { preferredName: 'Sam', tone: 'warm' },
      },
    },
  });
}

function revisionFor(document: FlexibleWorkingMemory): string {
  return workingMemoryRevision(document);
}

describe('working memory document', () => {
  it('uses canonical JSON so object insertion order does not change the revision', () => {
    const first = FlexibleWorkingMemorySchema.parse({
      version: 1,
      entries: {
        [goalId]: {
          kind: 'goal',
          summary: 'Buy a car.',
          scope: 'household',
          value: { goal: 'BMW X5', timeframe: 'one year' },
        },
      },
    });
    const second = FlexibleWorkingMemorySchema.parse({
      entries: {
        [goalId]: {
          value: { timeframe: 'one year', goal: 'BMW X5' },
          scope: 'household',
          summary: 'Buy a car.',
          kind: 'goal',
        },
      },
      version: 1,
    });
    expect(workingMemoryRevision(first)).toBe(workingMemoryRevision(second));
    expect(workingMemoryRevision(first)).not.toBe(workingMemoryRevision({
      ...first,
      entries: { [goalId]: { ...first.entries[goalId]!, value: { goal: 'BMW X7' } } },
    }));
  });

  it('returns household and current-member entries without exposing another member', () => {
    expect(visibleWorkingMemoryEntries({ document: documentFixture(), principalRef })).toEqual([
      {
        entryId: goalId,
        kind: 'goal',
        summary: 'Buy a BMW X5 within one year.',
        scope: 'household',
        value: { goal: 'BMW X5', timeframe: 'one year' },
      },
      {
        entryId: memberId,
        kind: 'member_context',
        summary: 'Alex prefers concise updates.',
        scope: 'member',
        value: { preferredName: 'Alex', detail: 'concise' },
      },
    ]);
  });

  it('migrates strict legacy categories and preserves unknown bounded fields', () => {
    const decoded = decodeStoredWorkingMemory({
      stored: JSON.stringify({
        goals: { car: { summary: 'Buy a BMW X5.', horizon: 'one year', priority: 'high' } },
        savingPreferences: { style: 'balanced', cadence: 'monthly' },
        communication: { tone: 'warm' },
        conventions: { groceryCategory: 'Groceries' },
        members: { 'telegram:user:1': { preferredName: 'Alex' } },
        futureFeature: { enabled: true, label: 'preserve me' },
      }),
      ids: idGenerator(),
    });

    expect(decoded.status).toBe('succeeded');
    if (decoded.status !== 'succeeded') throw new Error('Expected migrated document');
    expect(decoded.migrated).toBe(true);
    const entries = Object.values(decoded.document.entries);
    expect(entries.map((entry) => entry.kind)).toEqual(expect.arrayContaining([
      'goal',
      'saving_preference',
      'communication_preference',
      'convention',
      'member_context',
      'other',
    ]));
    expect(entries.find((entry) => entry.kind === 'member_context')?.ownerPrincipalRef).toBe('telegram:user:1');
    expect(entries.find((entry) => entry.kind === 'other')?.value).toEqual({
      futureFeature: { enabled: true, label: 'preserve me' },
    });
  });

  it('accepts an already flexible document with lifecycle without marking it migrated and reports malformed JSON safely', () => {
    const lifecycle = {
      createdAt: '2026-07-25T10:55:00.000Z',
      updatedAt: '2026-07-25T10:55:00.000Z',
    };
    const storedDocument = FlexibleWorkingMemorySchema.parse({
      ...documentFixture(),
      entries: Object.fromEntries(Object.entries(documentFixture().entries).map(([entryId, entry]) => [
        entryId,
        { ...entry, lifecycle },
      ])),
    });
    const stored = JSON.stringify(storedDocument);
    expect(decodeStoredWorkingMemory({ stored, ids: idGenerator() })).toMatchObject({
      status: 'succeeded',
      migrated: false,
      document: storedDocument,
    });
    expect(decodeStoredWorkingMemory({ stored: '{bad', ids: idGenerator() })).toEqual({
      status: 'failed',
      code: 'working_memory_read_failed',
    });
  });

  it('creates a server-owned entry and requires confirmation only for a duplicate kind', () => {
    const empty = FlexibleWorkingMemorySchema.parse({ version: 1, entries: {} });
    const create = {
      operation: 'create' as const,
      basedOnRevision: revisionFor(empty),
      kind: 'goal' as const,
      summary: 'Buy a BMW X5.',
      scope: 'household' as const,
      value: { goal: 'BMW X5' },
    };
    const first = resolveWorkingMemoryMutation({
      draft: create,
      document: empty,
      principalRef,
      ids: idGenerator(),
    });
    expect(first).toMatchObject({ status: 'succeeded', requiresConfirmation: false });
    if (first.status !== 'succeeded') throw new Error('Expected create resolution');
    expect(first.mutation).toEqual({
      operation: 'create',
      entryId: nextId,
      entry: {
        kind: 'goal',
        summary: 'Buy a BMW X5.',
        scope: 'household',
        value: { goal: 'BMW X5' },
      },
    });

    const duplicate = resolveWorkingMemoryMutation({
      draft: { ...create, basedOnRevision: revisionFor(documentFixture()) },
      document: documentFixture(),
      principalRef,
      ids: idGenerator(),
    });
    expect(duplicate).toMatchObject({ status: 'succeeded', requiresConfirmation: true });
  });

  it('replaces one complete entry without retaining old aliases or changing ownership', () => {
    const document = documentFixture();
    const result = resolveWorkingMemoryMutation({
      draft: {
        operation: 'replace',
        basedOnRevision: revisionFor(document),
        entryId: goalId,
        kind: 'goal',
        summary: 'Buy a BMW X7 within two years.',
        value: { goals: ['BMW X7'], timeframe: 'two years' },
      },
      document,
      principalRef,
      ids: idGenerator(),
    });
    expect(result).toMatchObject({ status: 'succeeded', requiresConfirmation: true });
    if (result.status !== 'succeeded') throw new Error('Expected replacement resolution');
    expect(result.mutation).toEqual({
      operation: 'replace',
      entryId: goalId,
      entry: {
        kind: 'goal',
        summary: 'Buy a BMW X7 within two years.',
        scope: 'household',
        value: { goals: ['BMW X7'], timeframe: 'two years' },
      },
    });
    const applied = applyResolvedWorkingMemoryMutation({ document, mutation: result.mutation, principalRef });
    expect(applied).toMatchObject({ status: 'succeeded' });
    if (applied.status !== 'succeeded') throw new Error('Expected replacement application');
    expect(applied.document.entries[goalId]?.value).toEqual({ goals: ['BMW X7'], timeframe: 'two years' });
    expect(applied.document.entries[goalId]?.value).not.toHaveProperty('goal');
  });

  it('deletes exactly one authorized entry and clears the complete document', () => {
    const document = documentFixture();
    const deletion = resolveWorkingMemoryMutation({
      draft: { operation: 'delete', basedOnRevision: revisionFor(document), entryId: goalId },
      document,
      principalRef,
      ids: idGenerator(),
    });
    expect(deletion).toMatchObject({ status: 'succeeded', requiresConfirmation: true });
    if (deletion.status !== 'succeeded') throw new Error('Expected delete resolution');
    const deleted = applyResolvedWorkingMemoryMutation({ document, mutation: deletion.mutation, principalRef });
    expect(deleted).toMatchObject({ status: 'succeeded' });
    if (deleted.status !== 'succeeded') throw new Error('Expected delete application');
    expect(Object.keys(deleted.document.entries)).toEqual([memberId, otherMemberId]);

    const cleared = applyResolvedWorkingMemoryMutation({
      document,
      mutation: { operation: 'clear' },
      principalRef,
    });
    expect(cleared).toEqual({ status: 'succeeded', document: { version: 1, entries: {} } });
  });

  it('rejects stale, unknown, invalid, unauthorized, and expired mutations without a document', () => {
    const document = documentFixture();
    expect(resolveWorkingMemoryMutation({
      draft: { operation: 'delete', basedOnRevision: 'b'.repeat(64), entryId: goalId },
      document,
      principalRef,
      ids: idGenerator(),
    })).toEqual({ status: 'failed', code: 'working_memory_revision_conflict' });
    expect(resolveWorkingMemoryMutation({
      draft: { operation: 'delete', basedOnRevision: revisionFor(document), entryId: nextId },
      document,
      principalRef,
      ids: idGenerator(),
    })).toEqual({ status: 'failed', code: 'working_memory_entry_not_found' });
    expect(resolveWorkingMemoryMutation({
      draft: { operation: 'delete', basedOnRevision: revisionFor(document), entryId: otherMemberId },
      document,
      principalRef,
      ids: idGenerator(),
    })).toEqual({ status: 'failed', code: 'working_memory_entry_forbidden' });
    expect(resolveWorkingMemoryMutation({
      draft: { operation: 'not-an-operation' } as never,
      document,
      principalRef,
      ids: idGenerator(),
    })).toEqual({ status: 'failed', code: 'working_memory_mutation_invalid' });
    expect(proposalExpired('2026-07-25T11:10:00Z', new Date('2026-07-25T11:10:00Z'))).toBe(true);
    expect(proposalExpired('2026-07-25T11:10:00Z', new Date('2026-07-25T11:09:59Z'))).toBe(false);
  });

  it('detects missing create, unchanged replace, surviving delete, and non-empty clear on readback', () => {
    const before = documentFixture();
    const createMutation: ResolvedWorkingMemoryMutation = {
      operation: 'create',
      entryId: nextId,
      entry: { kind: 'goal', summary: 'Save more.', scope: 'household', value: { goal: 'save' } },
    };
    expect(verifyWorkingMemoryReadback({ before, after: before, mutation: createMutation })).toBe(false);
    expect(verifyWorkingMemoryReadback({
      before,
      after: { ...before, entries: { ...before.entries, [nextId]: createMutation.entry } },
      mutation: createMutation,
    })).toBe(true);

    const replaceMutation: ResolvedWorkingMemoryMutation = {
      operation: 'replace',
      entryId: goalId,
      entry: { kind: 'goal', summary: 'Buy a BMW X7.', scope: 'household', value: { goal: 'BMW X7' } },
    };
    expect(verifyWorkingMemoryReadback({ before, after: before, mutation: replaceMutation })).toBe(false);

    const deleteMutation: ResolvedWorkingMemoryMutation = { operation: 'delete', entryId: goalId };
    expect(verifyWorkingMemoryReadback({ before, after: before, mutation: deleteMutation })).toBe(false);
    expect(verifyWorkingMemoryReadback({
      before,
      after: { ...before, entries: { [memberId]: before.entries[memberId]!, [otherMemberId]: before.entries[otherMemberId]! } },
      mutation: deleteMutation,
    })).toBe(true);

    const clearMutation: ResolvedWorkingMemoryMutation = { operation: 'clear' };
    expect(verifyWorkingMemoryReadback({ before, after: before, mutation: clearMutation })).toBe(false);
    expect(verifyWorkingMemoryReadback({ before, after: { version: 1, entries: {} }, mutation: clearMutation })).toBe(true);
  });
});
