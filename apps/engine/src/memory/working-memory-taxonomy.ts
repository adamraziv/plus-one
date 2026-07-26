import { createHash } from 'node:crypto';
import type {
  JsonValue,
  WorkingMemoryKind,
} from '@plus-one/contracts';

export type WorkingMemoryKindPolicy = {
  kind: WorkingMemoryKind;
  label: string;
  description: string;
  preferredScopes: readonly ('household' | 'member')[];
  summaryStyle: 'identity' | 'preference' | 'goal' | 'convention' | 'legacy';
  duplicateKey: 'canonical_value' | 'subject_and_fields' | 'none';
  conflictPolicy: 'replace_candidate' | 'show_both' | 'manual_review';
  reviewAfterDays?: number;
};

const POLICIES: Record<WorkingMemoryKind, WorkingMemoryKindPolicy> = {
  member_context: {
    kind: 'member_context',
    label: 'Member context',
    description: 'Stable context about the authenticated household member.',
    preferredScopes: ['member'],
    summaryStyle: 'identity',
    duplicateKey: 'subject_and_fields',
    conflictPolicy: 'replace_candidate',
  },
  communication_preference: {
    kind: 'communication_preference',
    label: 'Communication preference',
    description: 'How Plus One should communicate with a member or household.',
    preferredScopes: ['member', 'household'],
    summaryStyle: 'preference',
    duplicateKey: 'subject_and_fields',
    conflictPolicy: 'manual_review',
    reviewAfterDays: 180,
  },
  saving_preference: {
    kind: 'saving_preference',
    label: 'Saving preference',
    description: 'A member or household preference related to saving behavior.',
    preferredScopes: ['member', 'household'],
    summaryStyle: 'preference',
    duplicateKey: 'subject_and_fields',
    conflictPolicy: 'manual_review',
    reviewAfterDays: 180,
  },
  goal: {
    kind: 'goal',
    label: 'Goal',
    description: 'A member or household financial goal.',
    preferredScopes: ['member', 'household'],
    summaryStyle: 'goal',
    duplicateKey: 'canonical_value',
    conflictPolicy: 'show_both',
    reviewAfterDays: 90,
  },
  convention: {
    kind: 'convention',
    label: 'Household convention',
    description: 'A convention shared by the household.',
    preferredScopes: ['household'],
    summaryStyle: 'convention',
    duplicateKey: 'canonical_value',
    conflictPolicy: 'manual_review',
    reviewAfterDays: 365,
  },
  other: {
    kind: 'other',
    label: 'Legacy memory',
    description: 'A readable legacy fact without a more specific taxonomy kind.',
    preferredScopes: ['household', 'member'],
    summaryStyle: 'legacy',
    duplicateKey: 'none',
    conflictPolicy: 'show_both',
  },
};

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function workingMemoryKindPolicy(kind: WorkingMemoryKind): WorkingMemoryKindPolicy {
  return POLICIES[kind];
}

export function normalizeWorkingMemorySummary(summary: string): string {
  return summary.trim().replace(/\s+/g, ' ');
}

export function canonicalizeWorkingMemoryValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => canonicalizeWorkingMemoryValue(item));
  if (value !== null && typeof value === 'object') {
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      if (DANGEROUS_KEYS.has(key)) throw new Error(`Working Memory key is not allowed: ${key}`);
      output[key] = canonicalizeWorkingMemoryValue(value[key]!);
    }
    return output;
  }
  return value;
}

export function workingMemoryEntryFingerprint(input: {
  kind: WorkingMemoryKind;
  scope: 'household' | 'member';
  ownerPrincipalRef?: string | undefined;
  value: JsonValue;
}): string {
  const canonical = canonicalizeWorkingMemoryValue({
    kind: input.kind,
    scope: input.scope,
    ownerPrincipalRef: input.ownerPrincipalRef ?? null,
    value: input.value,
  });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function workingMemoryScopePolicyIssue(input: {
  kind: WorkingMemoryKind;
  scope: 'household' | 'member';
}): string | undefined {
  const policy = workingMemoryKindPolicy(input.kind);
  if (policy.preferredScopes.includes(input.scope)) return undefined;
  return `${policy.label} entries must use ${policy.preferredScopes.join(' or ')} scope.`;
}
