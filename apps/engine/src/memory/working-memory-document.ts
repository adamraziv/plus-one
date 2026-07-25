import { randomBytes } from 'node:crypto';
import {
  FlexibleWorkingMemorySchema,
  LegacyHouseholdWorkingMemorySchema,
  ResolvedWorkingMemoryMutationSchema,
  WorkingMemoryEntryIdSchema,
  WorkingMemoryEntrySchema,
  WorkingMemoryMutationDraftSchema,
  WorkingMemoryProposalIdSchema,
  WorkingMemoryRevisionSchema,
  WorkingMemoryValueSchema,
  type FlexibleWorkingMemory,
  type JsonValue,
  type ResolvedWorkingMemoryMutation,
  type WorkingMemoryEntry,
  type WorkingMemoryEntryId,
  type WorkingMemoryInspectionResult,
  type WorkingMemoryProposalId,
} from '@plus-one/contracts';
import { canonicalizeJson, hashArtifact } from '@plus-one/runtime';

export interface WorkingMemoryIdGenerator {
  nextEntryId(): WorkingMemoryEntryId;
  nextProposalId(): WorkingMemoryProposalId;
}

export type DecodeStoredWorkingMemoryResult =
  | { status: 'succeeded'; document: FlexibleWorkingMemory; migrated: boolean }
  | { status: 'failed'; code: 'working_memory_read_failed' };

export type ResolveWorkingMemoryMutationResult =
  | {
      status: 'succeeded';
      mutation: ResolvedWorkingMemoryMutation;
      requiresConfirmation: boolean;
    }
  | {
      status: 'failed';
      code:
        | 'working_memory_mutation_invalid'
        | 'working_memory_revision_conflict'
        | 'working_memory_entry_not_found'
        | 'working_memory_entry_forbidden';
    };

export type ApplyWorkingMemoryMutationResult =
  | { status: 'succeeded'; document: FlexibleWorkingMemory }
  | {
      status: 'failed';
      code:
        | 'working_memory_mutation_invalid'
        | 'working_memory_entry_not_found'
        | 'working_memory_entry_forbidden'
        | 'working_memory_write_rejected';
    };

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulid(): string {
  let time = Date.now();
  let output = '';
  for (let index = 0; index < 10; index += 1) {
    output = CROCKFORD[time % 32]! + output;
    time = Math.floor(time / 32);
  }

  const randomness = randomBytes(16);
  let buffer = 0;
  let bits = 0;
  for (const byte of randomness) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < 26) {
      bits -= 5;
      output += CROCKFORD[(buffer >> bits) & 31]!;
    }
  }
  while (output.length < 26) output += CROCKFORD[0]!;
  return output;
}

export function createWorkingMemoryIdGenerator(): WorkingMemoryIdGenerator {
  return {
    nextEntryId: () => WorkingMemoryEntryIdSchema.parse(`wme_${ulid()}`),
    nextProposalId: () => WorkingMemoryProposalIdSchema.parse(`wmproposal_${ulid()}`),
  };
}

export function workingMemoryRevision(document: FlexibleWorkingMemory) {
  return WorkingMemoryRevisionSchema.parse(hashArtifact(asJsonValue(document)));
}

export function visibleWorkingMemoryEntries(input: {
  document: FlexibleWorkingMemory;
  principalRef: string;
}): WorkingMemoryInspectionResult['entries'] {
  return Object.entries(input.document.entries)
    .filter(([, entry]) => entry.scope === 'household' || entry.ownerPrincipalRef === input.principalRef)
    .map(([entryId, entry]) => ({
      entryId: WorkingMemoryEntryIdSchema.parse(entryId),
      kind: entry.kind,
      summary: entry.summary,
      scope: entry.scope,
      value: entry.value,
    }));
}

export function decodeStoredWorkingMemory(input: {
  stored: string | null;
  ids: WorkingMemoryIdGenerator;
}): DecodeStoredWorkingMemoryResult {
  if (input.stored === null) {
    return { status: 'succeeded', document: emptyWorkingMemoryDocument(), migrated: false };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(input.stored);
  } catch {
    return { status: 'failed', code: 'working_memory_read_failed' };
  }

  const flexible = FlexibleWorkingMemorySchema.safeParse(raw);
  if (flexible.success) return { status: 'succeeded', document: flexible.data, migrated: false };

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'failed', code: 'working_memory_read_failed' };
  }

  const knownKeys = ['goals', 'savingPreferences', 'communication', 'conventions', 'members'] as const;
  const known = Object.fromEntries(
    knownKeys
      .filter((key) => Object.prototype.hasOwnProperty.call(raw, key))
      .map((key) => [key, (raw as Record<string, unknown>)[key]]),
  );
  const legacy = LegacyHouseholdWorkingMemorySchema.safeParse(known);
  if (!legacy.success) return { status: 'failed', code: 'working_memory_read_failed' };

  const entries: Record<string, WorkingMemoryEntry> = {};
  const addEntry = (entry: WorkingMemoryEntry): void => {
    let entryId = input.ids.nextEntryId();
    while (entries[entryId] !== undefined) entryId = input.ids.nextEntryId();
    entries[entryId] = WorkingMemoryEntrySchema.parse(entry);
  };

  for (const [key, goal] of Object.entries(legacy.data.goals ?? {})) {
    addEntry({
      kind: 'goal',
      summary: goal.summary,
      scope: 'household',
      value: asJsonValue(goal),
    });
    void key;
  }
  if (legacy.data.savingPreferences !== undefined) {
    addEntry({
      kind: 'saving_preference',
      summary: 'Saving preferences',
      scope: 'household',
      value: asJsonValue(legacy.data.savingPreferences),
    });
  }
  if (legacy.data.communication !== undefined) {
    addEntry({
      kind: 'communication_preference',
      summary: 'Communication preferences',
      scope: 'household',
      value: asJsonValue(legacy.data.communication),
    });
  }
  for (const [key, convention] of Object.entries(legacy.data.conventions ?? {})) {
    addEntry({
      kind: 'convention',
      summary: convention,
      scope: 'household',
      value: asJsonValue({ key, convention }),
    });
  }
  for (const [ownerPrincipalRef, member] of Object.entries(legacy.data.members ?? {})) {
    addEntry({
      kind: 'member_context',
      summary: member.preferredName ?? member.nickname ?? `Member ${ownerPrincipalRef}`,
      scope: 'member',
      ownerPrincipalRef,
      value: asJsonValue(member),
    });
  }

  const unknown = Object.fromEntries(
    Object.entries(raw).filter(([key]) => !knownKeys.includes(key as typeof knownKeys[number])),
  );
  if (Object.keys(unknown).length > 0) {
    const unknownValue = WorkingMemoryValueSchema.safeParse(unknown);
    if (!unknownValue.success) return { status: 'failed', code: 'working_memory_read_failed' };
    addEntry({
      kind: 'other',
      summary: 'Legacy working memory',
      scope: 'household',
      value: unknownValue.data,
    });
  }

  const document = FlexibleWorkingMemorySchema.safeParse({ version: 1, entries });
  if (!document.success) return { status: 'failed', code: 'working_memory_read_failed' };
  return { status: 'succeeded', document: document.data, migrated: true };
}

export function resolveWorkingMemoryMutation(input: {
  draft: unknown;
  document: FlexibleWorkingMemory;
  principalRef: string;
  ids: WorkingMemoryIdGenerator;
}): ResolveWorkingMemoryMutationResult {
  const parsed = WorkingMemoryMutationDraftSchema.safeParse(input.draft);
  if (!parsed.success) return { status: 'failed', code: 'working_memory_mutation_invalid' };
  const draft = parsed.data;
  if (draft.basedOnRevision !== workingMemoryRevision(input.document)) {
    return { status: 'failed', code: 'working_memory_revision_conflict' };
  }

  if (draft.operation === 'create') {
    const entry: WorkingMemoryEntry = {
      kind: draft.kind,
      summary: draft.summary,
      scope: draft.scope,
      ...(draft.scope === 'member' ? { ownerPrincipalRef: input.principalRef } : {}),
      value: draft.value,
    };
    const mutation: ResolvedWorkingMemoryMutation = {
      operation: 'create',
      entryId: input.ids.nextEntryId(),
      entry,
    };
    const requiresConfirmation = visibleWorkingMemoryEntries(input).some((item) => item.kind === draft.kind);
    return { status: 'succeeded', mutation, requiresConfirmation };
  }

  if (draft.operation === 'clear') {
    return { status: 'succeeded', mutation: { operation: 'clear' }, requiresConfirmation: true };
  }

  const existing = input.document.entries[draft.entryId];
  if (existing === undefined) return { status: 'failed', code: 'working_memory_entry_not_found' };
  if (!canAccessWorkingMemoryEntry(existing, input.principalRef)) {
    return { status: 'failed', code: 'working_memory_entry_forbidden' };
  }
  if (draft.operation === 'delete') {
    return {
      status: 'succeeded',
      mutation: { operation: 'delete', entryId: draft.entryId },
      requiresConfirmation: true,
    };
  }

  return {
    status: 'succeeded',
    mutation: {
      operation: 'replace',
      entryId: draft.entryId,
      entry: {
        kind: draft.kind,
        summary: draft.summary,
        scope: existing.scope,
        ...(existing.scope === 'member' ? { ownerPrincipalRef: existing.ownerPrincipalRef } : {}),
        value: draft.value,
      },
    },
    requiresConfirmation: true,
  };
}

export function applyResolvedWorkingMemoryMutation(input: {
  document: FlexibleWorkingMemory;
  mutation: unknown;
  principalRef: string;
}): ApplyWorkingMemoryMutationResult {
  const parsed = ResolvedWorkingMemoryMutationSchema.safeParse(input.mutation);
  if (!parsed.success) return { status: 'failed', code: 'working_memory_mutation_invalid' };
  const mutation = parsed.data;
  if (mutation.operation === 'clear') return { status: 'succeeded', document: emptyWorkingMemoryDocument() };

  const entries = { ...input.document.entries };
  if (mutation.operation === 'create') {
    if (entries[mutation.entryId] !== undefined) {
      return { status: 'failed', code: 'working_memory_write_rejected' };
    }
    if (!canAccessWorkingMemoryEntry(mutation.entry, input.principalRef)) {
      return { status: 'failed', code: 'working_memory_entry_forbidden' };
    }
    entries[mutation.entryId] = mutation.entry;
  } else {
    const existing = entries[mutation.entryId];
    if (existing === undefined) return { status: 'failed', code: 'working_memory_entry_not_found' };
    if (!canAccessWorkingMemoryEntry(existing, input.principalRef)) {
      return { status: 'failed', code: 'working_memory_entry_forbidden' };
    }
    if (mutation.operation === 'delete') delete entries[mutation.entryId];
    else {
      if (existing.scope !== mutation.entry.scope
        || existing.ownerPrincipalRef !== mutation.entry.ownerPrincipalRef) {
        return { status: 'failed', code: 'working_memory_entry_forbidden' };
      }
      entries[mutation.entryId] = mutation.entry;
    }
  }

  const document = FlexibleWorkingMemorySchema.safeParse({ version: 1, entries });
  if (!document.success) return { status: 'failed', code: 'working_memory_write_rejected' };
  return { status: 'succeeded', document: document.data };
}

export function verifyWorkingMemoryReadback(input: {
  before: FlexibleWorkingMemory;
  after: FlexibleWorkingMemory;
  mutation: ResolvedWorkingMemoryMutation;
}): boolean {
  const before = input.before.entries;
  const after = input.after.entries;
  if (input.mutation.operation === 'create') {
    return after[input.mutation.entryId] !== undefined
      && canonicalizeWorkingMemoryValue(after[input.mutation.entryId]!) === canonicalizeWorkingMemoryValue(input.mutation.entry)
      && before[input.mutation.entryId] === undefined;
  }
  if (input.mutation.operation === 'replace') {
    return before[input.mutation.entryId] !== undefined
      && canonicalizeWorkingMemoryValue(before[input.mutation.entryId]!) !== canonicalizeWorkingMemoryValue(input.mutation.entry)
      && after[input.mutation.entryId] !== undefined
      && canonicalizeWorkingMemoryValue(after[input.mutation.entryId]!) === canonicalizeWorkingMemoryValue(input.mutation.entry);
  }
  if (input.mutation.operation === 'delete') {
    return before[input.mutation.entryId] !== undefined && after[input.mutation.entryId] === undefined;
  }
  return Object.keys(after).length === 0 && Object.keys(before).length > 0;
}

export function proposalExpired(expiresAt: string, now: Date): boolean {
  return Date.parse(expiresAt) <= now.getTime();
}

function emptyWorkingMemoryDocument(): FlexibleWorkingMemory {
  return { version: 1, entries: {} };
}

function canAccessWorkingMemoryEntry(entry: WorkingMemoryEntry, principalRef: string): boolean {
  return entry.scope === 'household' || entry.ownerPrincipalRef === principalRef;
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function canonicalizeWorkingMemoryValue(value: unknown): string {
  return canonicalizeJson(asJsonValue(value));
}
