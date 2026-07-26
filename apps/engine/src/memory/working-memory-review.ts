import {
  WorkingMemoryEntryIdSchema,
  WorkingMemoryReviewReportSchema,
  type FlexibleWorkingMemory,
  type JsonValue,
  type WorkingMemoryEntry,
  type WorkingMemoryReviewFinding,
  type WorkingMemoryReviewReport,
  type UtcInstant,
} from '@plus-one/contracts';
import { workingMemoryRevision } from './working-memory-document.js';
import {
  workingMemoryEntryFingerprint,
  workingMemoryKindPolicy,
  workingMemoryScopePolicyIssue,
} from './working-memory-taxonomy.js';

type ReviewEntry = {
  entryId: string;
  entry: WorkingMemoryEntry;
};

export function reviewWorkingMemoryDocument(input: {
  document: FlexibleWorkingMemory;
  principalRef: string;
  now: UtcInstant;
}): WorkingMemoryReviewReport {
  const revision = revisionForReviewDocument(input.document);
  const visible = Object.entries(input.document.entries)
    .filter(([, entry]) => entry.scope === 'household' || entry.ownerPrincipalRef === input.principalRef)
    .map(([entryId, entry]) => ({ entryId: WorkingMemoryEntryIdSchema.parse(entryId), entry }));
  const findings: WorkingMemoryReviewFinding[] = [];

  for (const item of visible) {
    if (workingMemoryScopePolicyIssue({ kind: item.entry.kind, scope: item.entry.scope }) !== undefined) {
      findings.push({
        category: 'scope_mismatch',
        entryIds: [item.entryId],
        explanation: `${workingMemoryKindPolicy(item.entry.kind).label} is stored with an incompatible scope.`,
        proposedOperation: 'none',
        basedOnRevision: revision,
      });
    }
    if (isStale(item.entry, input.now)) {
      findings.push({
        category: 'stale',
        entryIds: [item.entryId],
        explanation: `${workingMemoryKindPolicy(item.entry.kind).label} should be reviewed because its lifecycle or review interval is due.`,
        proposedOperation: 'none',
        basedOnRevision: revision,
      });
    }
  }

  const duplicateGroups = new Map<string, ReviewEntry[]>();
  for (const item of visible) {
    const fingerprint = workingMemoryEntryFingerprint({
      kind: item.entry.kind,
      scope: item.entry.scope,
      ownerPrincipalRef: item.entry.ownerPrincipalRef,
      value: item.entry.value,
    });
    const group = duplicateGroups.get(fingerprint) ?? [];
    group.push(item);
    duplicateGroups.set(fingerprint, group);
  }
  for (const group of duplicateGroups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort(compareEntryAge);
    const unambiguousOlder = ordered[0]!.entry.lifecycle?.createdAt !== undefined
      && ordered[1]!.entry.lifecycle?.createdAt !== undefined
      && Date.parse(ordered[0]!.entry.lifecycle.createdAt) < Date.parse(ordered[1]!.entry.lifecycle.createdAt);
    findings.push({
      category: 'duplicate',
      entryIds: ordered.slice(0, 10).map((item) => item.entryId),
      explanation: 'These Working Memory entries contain the same canonical fact.',
      proposedOperation: unambiguousOlder ? 'delete' : 'none',
      basedOnRevision: revision,
    });
  }

  const byIdentity = new Map<string, ReviewEntry[]>();
  for (const item of visible) {
    const identity = JSON.stringify({
      kind: item.entry.kind,
      scope: item.entry.scope,
      ownerPrincipalRef: item.entry.ownerPrincipalRef ?? null,
    });
    const group = byIdentity.get(identity) ?? [];
    group.push(item);
    byIdentity.set(identity, group);
  }
  for (const group of byIdentity.values()) {
    if (group.length < 2) continue;
    const policy = workingMemoryKindPolicy(group[0]!.entry.kind);
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const first = group[left]!;
        const second = group[right]!;
        if (sameCanonicalValue(first.entry.value, second.entry.value)) continue;
        const differingFields = differingObjectFields(first.entry.value, second.entry.value);
        if (differingFields.length === 0 && policy.conflictPolicy !== 'manual_review') continue;
        findings.push({
          category: 'contradiction',
          entryIds: [first.entryId, second.entryId].sort(),
          explanation: differingFields.length === 0
            ? `${policy.label} has multiple active values that require a manual choice.`
            : `${policy.label} entries disagree on ${differingFields.join(', ')}.`,
          proposedOperation: 'none',
          basedOnRevision: revision,
        });
      }
    }
  }

  return WorkingMemoryReviewReportSchema.parse({
    status: 'succeeded',
    revision,
    reviewedAt: input.now,
    findings: findings
      .sort(compareFindings)
      .slice(0, 50),
  });
}

function isStale(entry: WorkingMemoryEntry, now: UtcInstant): boolean {
  const lifecycle = entry.lifecycle;
  if (lifecycle === undefined) return false;
  const nowMs = Date.parse(now);
  if (lifecycle.expiresAt !== undefined && Date.parse(lifecycle.expiresAt) <= nowMs) return true;
  const reviewAfterDays = workingMemoryKindPolicy(entry.kind).reviewAfterDays;
  if (reviewAfterDays === undefined) return false;
  const reference = lifecycle.lastReviewedAt ?? lifecycle.updatedAt;
  return Date.parse(reference) + reviewAfterDays * 24 * 60 * 60_000 <= nowMs;
}

function compareEntryAge(left: ReviewEntry, right: ReviewEntry): number {
  const leftCreated = left.entry.lifecycle?.createdAt;
  const rightCreated = right.entry.lifecycle?.createdAt;
  if (leftCreated !== undefined && rightCreated !== undefined) {
    const timeDifference = Date.parse(leftCreated) - Date.parse(rightCreated);
    if (timeDifference !== 0) return timeDifference;
  }
  return left.entryId.localeCompare(right.entryId);
}

function sameCanonicalValue(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
    || JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function differingObjectFields(left: JsonValue, right: JsonValue): string[] {
  if (!isJsonObject(left) || !isJsonObject(right)) return [];
  return Object.keys(left)
    .filter((key) => Object.prototype.hasOwnProperty.call(right, key))
    .filter((key) => !sameCanonicalValue(left[key]!, right[key]!))
    .sort();
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isJsonObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key]!) ]));
  }
  return value;
}

function compareFindings(left: WorkingMemoryReviewFinding, right: WorkingMemoryReviewFinding): number {
  const categoryOrder = { duplicate: 0, contradiction: 1, scope_mismatch: 2, stale: 3 } as const;
  const categoryDifference = categoryOrder[left.category] - categoryOrder[right.category];
  if (categoryDifference !== 0) return categoryDifference;
  return left.entryIds.join(',').localeCompare(right.entryIds.join(','));
}

function revisionForReviewDocument(document: FlexibleWorkingMemory): string {
  return workingMemoryRevision(document);
}
