import { describe, expect, it } from 'vitest';
import {
  FlexibleWorkingMemorySchema,
  LegacyHouseholdWorkingMemorySchema,
  MAX_WORKING_MEMORY_KEY_LENGTH,
  MAX_WORKING_MEMORY_LIST_ITEMS,
  MAX_WORKING_MEMORY_RECORD_ENTRIES,
  MAX_WORKING_MEMORY_TEXT_LENGTH,
  WorkingMemoryEntryIdSchema,
  WorkingMemoryKindSchema,
  WorkingMemoryMutationDraftSchema,
  WorkingMemoryProposalIdSchema,
  PendingWorkingMemoryMutationSchema,
} from './working-memory.js';

const representativeMemory = {
  goals: {
    emergencyFund: {
      summary: 'Build a six-month emergency fund.',
      horizon: 'Within two years',
      priority: 'high',
    },
  },
  savingPreferences: {
    style: 'balanced',
    priorities: ['Emergency fund', 'Home repairs'],
    cadence: 'Review savings every payday.',
    constraints: ['Keep three months of expenses liquid.'],
  },
  communication: {
    tone: 'warm and direct',
    detail: 'concise',
    reminders: 'weekly',
  },
  conventions: {
    groceryCategory: 'Use Groceries for ordinary supermarket purchases.',
  },
  members: {
    'telegram:user:1': {
      nickname: 'Alex',
      preferredName: 'Alexandra',
      communication: {
        tone: 'friendly',
        detail: 'brief',
      },
    },
  },
} as const;

describe('LegacyHouseholdWorkingMemorySchema', () => {
  it('accepts an empty document and representative structured memory', () => {
    expect(LegacyHouseholdWorkingMemorySchema.parse({})).toEqual({});
    expect(LegacyHouseholdWorkingMemorySchema.parse(representativeMemory)).toEqual(representativeMemory);
  });

  it('accepts channel principal references and rejects unsafe member keys', () => {
    expect(LegacyHouseholdWorkingMemorySchema.parse({
      members: { 'telegram:user:1': { nickname: 'Alex' } },
    }).members?.['telegram:user:1']?.nickname).toBe('Alex');

    expect(() => LegacyHouseholdWorkingMemorySchema.parse({
      members: { 'telegram user 1': { nickname: 'Alex' } },
    })).toThrow();
    expect(() => LegacyHouseholdWorkingMemorySchema.parse({
      members: { '   ': { nickname: 'Alex' } },
    })).toThrow();
  });

  it('enforces text, key, list, and record bounds', () => {
    expect(() => LegacyHouseholdWorkingMemorySchema.parse({
      conventions: { key: 'x'.repeat(MAX_WORKING_MEMORY_TEXT_LENGTH + 1) },
    })).toThrow();
    expect(() => LegacyHouseholdWorkingMemorySchema.parse({
      members: { ['x'.repeat(MAX_WORKING_MEMORY_KEY_LENGTH + 1)]: { nickname: 'Alex' } },
    })).toThrow();
    expect(() => LegacyHouseholdWorkingMemorySchema.parse({
      savingPreferences: { priorities: Array.from({ length: MAX_WORKING_MEMORY_LIST_ITEMS + 1 }, () => 'priority') },
    })).toThrow();
    expect(() => LegacyHouseholdWorkingMemorySchema.parse({
      conventions: Object.fromEntries(
        Array.from({ length: MAX_WORKING_MEMORY_RECORD_ENTRIES + 1 }, (_, index) => [`key-${index}`, 'value']),
      ),
    })).toThrow();
  });

  it('rejects unknown fields at every structured level', () => {
    expect(() => LegacyHouseholdWorkingMemorySchema.parse({ unexpected: 'value' })).toThrow();
    expect(() => LegacyHouseholdWorkingMemorySchema.parse({
      savingPreferences: { unexpected: 'value' },
    })).toThrow();
    expect(() => LegacyHouseholdWorkingMemorySchema.parse({
      members: { 'telegram:user:1': { unexpected: 'value' } },
    })).toThrow();
  });
});

const entryId = 'wme_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const proposalId = 'wmproposal_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const revision = 'a'.repeat(64);
const householdId = 'hh_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const conversationId = 'conversation_01ARZ3NDEKTSV4RRFFQ69G5FAV';

function flexibleEntry(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'goal',
    summary: 'Buy a car within one year.',
    scope: 'household',
    value: { goal: 'BMW X5', timeframe: 'one year' },
    ...overrides,
  };
}

function flexibleDocument(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    entries: { [entryId]: flexibleEntry() },
    ...overrides,
  };
}

describe('flexible Working Memory contracts', () => {
  it('accepts server-issued entry and proposal IDs but rejects model-friendly IDs', () => {
    expect(WorkingMemoryEntryIdSchema.parse(entryId)).toBe(entryId);
    expect(WorkingMemoryProposalIdSchema.parse(proposalId)).toBe(proposalId);
    expect(() => WorkingMemoryEntryIdSchema.parse('goal')).toThrow();
    expect(() => WorkingMemoryEntryIdSchema.parse('wme_short')).toThrow();
    expect(() => WorkingMemoryProposalIdSchema.parse('wmproposal_abc')).toThrow();
    expect(() => WorkingMemoryEntryIdSchema.parse(`wmproposal_${'A'.repeat(26)}`)).toThrow();
  });

  it('accepts the versioned envelope, all canonical kinds, and ownership rules', () => {
    expect(FlexibleWorkingMemorySchema.parse({ version: 1, entries: {} })).toEqual({ version: 1, entries: {} });
    expect(WorkingMemoryKindSchema.options).toEqual([
      'goal',
      'saving_preference',
      'communication_preference',
      'convention',
      'member_context',
      'other',
    ]);
    expect(FlexibleWorkingMemorySchema.parse(flexibleDocument({
      entries: {
        [entryId]: flexibleEntry({ scope: 'member', ownerPrincipalRef: 'telegram:user:1' }),
      },
    }))).toBeTruthy();
    expect(() => FlexibleWorkingMemorySchema.parse(flexibleDocument({
      entries: {
        [entryId]: flexibleEntry({ scope: 'member' }),
      },
    }))).toThrow(/owner/i);
    expect(() => FlexibleWorkingMemorySchema.parse(flexibleDocument({
      entries: {
        [entryId]: flexibleEntry({ ownerPrincipalRef: 'telegram:user:1' }),
      },
    }))).toThrow(/owner/i);
  });

  it('enforces document, value, key, list, string, and dangerous-key bounds', () => {
    const entries = Object.fromEntries(
      Array.from({ length: MAX_WORKING_MEMORY_RECORD_ENTRIES }, (_, index) => [
        `wme_01ARZ3NDEKTSV4RRFFQ69G${String(index).padStart(4, '0')}`,
        flexibleEntry(),
      ]),
    );
    expect(FlexibleWorkingMemorySchema.parse({ version: 1, entries })).toBeTruthy();
    expect(() => FlexibleWorkingMemorySchema.parse({
      version: 1,
      entries: {
        ...entries,
        'wme_01ARZ3NDEKTSV4RRFFQ69G9999': flexibleEntry(),
      },
    })).toThrow();

    const nested = (depth: number): unknown => {
      let value: unknown = 'ok';
      for (let index = 0; index < depth; index += 1) value = { nested: value };
      return value;
    };
    expect(FlexibleWorkingMemorySchema.parse(flexibleDocument({
      entries: { [entryId]: flexibleEntry({ value: nested(6) }) },
    }))).toBeTruthy();
    expect(() => FlexibleWorkingMemorySchema.parse(flexibleDocument({
      entries: { [entryId]: flexibleEntry({ value: nested(7) }) },
    }))).toThrow(/depth/i);

    const fiftyKeys = Object.fromEntries(
      Array.from({ length: MAX_WORKING_MEMORY_RECORD_ENTRIES }, (_, index) => [`key-${index}`, 'value']),
    );
    expect(FlexibleWorkingMemorySchema.parse(flexibleDocument({
      entries: { [entryId]: flexibleEntry({ value: fiftyKeys }) },
    }))).toBeTruthy();
    expect(() => FlexibleWorkingMemorySchema.parse(flexibleDocument({
      entries: { [entryId]: flexibleEntry({ value: { ...fiftyKeys, extra: 'value' } }) },
    }))).toThrow(/entries/i);

    expect(FlexibleWorkingMemorySchema.parse(flexibleDocument({
      entries: { [entryId]: flexibleEntry({
        value: { ['k'.repeat(MAX_WORKING_MEMORY_KEY_LENGTH)]: 'x'.repeat(MAX_WORKING_MEMORY_TEXT_LENGTH) },
      }) },
    }))).toBeTruthy();
    expect(() => FlexibleWorkingMemorySchema.parse(flexibleDocument({
      entries: { [entryId]: flexibleEntry({ value: { ['k'.repeat(MAX_WORKING_MEMORY_KEY_LENGTH + 1)]: 'value' } }) },
    }))).toThrow(/key/i);
    expect(() => FlexibleWorkingMemorySchema.parse(flexibleDocument({
      entries: { [entryId]: flexibleEntry({ value: { key: 'x'.repeat(MAX_WORKING_MEMORY_TEXT_LENGTH + 1) } }) },
    }))).toThrow(/string|text/i);
    expect(() => FlexibleWorkingMemorySchema.parse(flexibleDocument({
      entries: { [entryId]: flexibleEntry({ value: { key: Array.from({ length: MAX_WORKING_MEMORY_LIST_ITEMS + 1 }, () => 'x') } }) },
    }))).toThrow(/items|list/i);

    for (const dangerousKey of ['__proto__', 'prototype', 'constructor']) {
      const dangerousValue = flexibleDocument({
        entries: {
          [entryId]: flexibleEntry({ value: { nested: Object.fromEntries([[dangerousKey, 'blocked']]) } }),
        },
      });
      const result = FlexibleWorkingMemorySchema.safeParse(dangerousValue);
      if (result.success) throw new Error(`${dangerousKey} was accepted`);
      expect(result.error.message).toMatch(/dangerous|key/i);
    }
  });

  it('enforces the complete document byte bound', () => {
    const build = (commonLength: number, finalLength: number) => ({
      version: 1,
      entries: Object.fromEntries(Array.from({ length: 3 }, (_, entryIndex) => [
        `wme_01ARZ3NDEKTSV4RRFFQ69G${String(entryIndex).padStart(4, '0')}`,
        flexibleEntry({
          value: Object.fromEntries(Array.from({ length: 50 }, (_, keyIndex) => [
            `key-${keyIndex}`,
            'x'.repeat(entryIndex === 2 && keyIndex === 49 ? finalLength : commonLength),
          ])),
        }),
      ])),
    });
    let exact: ReturnType<typeof build> | undefined;
    for (let commonLength = 1; commonLength <= MAX_WORKING_MEMORY_TEXT_LENGTH && exact === undefined; commonLength += 1) {
      const base = build(commonLength, 1);
      const needed = 64 * 1024 - Buffer.byteLength(JSON.stringify(base), 'utf8') + 1;
      if (needed >= 1 && needed <= MAX_WORKING_MEMORY_TEXT_LENGTH) {
        const candidate = build(commonLength, needed);
        if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') === 64 * 1024) exact = candidate;
      }
    }
    expect(exact).toBeDefined();
    expect(FlexibleWorkingMemorySchema.parse(exact)).toBeTruthy();
    expect(() => FlexibleWorkingMemorySchema.parse({
      ...exact,
      entries: {
        ...exact?.entries,
        'wme_01ARZ3NDEKTSV4RRFFQ69G9999': flexibleEntry(),
      },
    })).toThrow(/bytes|size/i);
  });

  it('keeps model mutation inputs separate from server-owned fields', () => {
    const create = {
      operation: 'create',
      basedOnRevision: revision,
      kind: 'goal',
      summary: 'Buy a BMW X5.',
      scope: 'household',
      value: { goal: 'BMW X5' },
    } as const;
    expect(WorkingMemoryMutationDraftSchema.parse(create)).toEqual(create);
    expect(() => WorkingMemoryMutationDraftSchema.parse({ ...create, entryId })).toThrow();
    expect(() => WorkingMemoryMutationDraftSchema.parse({ ...create, ownerPrincipalRef: 'telegram:user:1' })).toThrow();

    expect(WorkingMemoryMutationDraftSchema.parse({
      operation: 'replace',
      basedOnRevision: revision,
      entryId,
      kind: 'goal',
      summary: 'Buy a BMW X7.',
      value: { goal: 'BMW X7' },
    })).toBeTruthy();
    expect(() => WorkingMemoryMutationDraftSchema.parse({
      operation: 'replace',
      basedOnRevision: revision,
      entryId,
      kind: 'goal',
      summary: 'Buy a BMW X7.',
      scope: 'household',
      value: { goal: 'BMW X7' },
    })).toThrow();
    expect(WorkingMemoryMutationDraftSchema.parse({ operation: 'delete', basedOnRevision: revision, entryId })).toBeTruthy();
    expect(WorkingMemoryMutationDraftSchema.parse({ operation: 'clear', basedOnRevision: revision })).toBeTruthy();
    expect(() => WorkingMemoryMutationDraftSchema.parse({ operation: 'clear', basedOnRevision: revision, entryId })).toThrow();
  });

  it('validates authenticated pending proposals and their expiry window', () => {
    const now = '2026-07-25T10:55:00Z';
    const proposal = {
      proposalId,
      householdId,
      conversationId,
      speakerPrincipalRef: 'telegram:user:1',
      mutation: {
        operation: 'replace',
        entryId,
        entry: {
          kind: 'goal',
          summary: 'Buy a BMW X7.',
          scope: 'household',
          value: { goal: 'BMW X7' },
        },
      },
      basedOnRevision: revision,
      createdAt: now,
      expiresAt: '2026-07-25T11:10:00Z',
    };
    expect(PendingWorkingMemoryMutationSchema.parse(proposal)).toEqual(proposal);
    expect(() => PendingWorkingMemoryMutationSchema.parse({ ...proposal, basedOnRevision: 'bad' })).toThrow();
    expect(() => PendingWorkingMemoryMutationSchema.parse({ ...proposal, conversationId: undefined })).toThrow();
    expect(() => PendingWorkingMemoryMutationSchema.parse({ ...proposal, expiresAt: '2026-07-25T11:11:00Z' })).toThrow(/15|expiry|window/i);
  });
});
