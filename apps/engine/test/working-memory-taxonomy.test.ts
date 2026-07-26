import { describe, expect, it } from 'vitest';
import {
  canonicalizeWorkingMemoryValue,
  normalizeWorkingMemorySummary,
  workingMemoryEntryFingerprint,
  workingMemoryKindPolicy,
  workingMemoryScopePolicyIssue,
} from '../src/memory/working-memory-taxonomy.js';

describe('working memory taxonomy', () => {
  it('defines deterministic policies for every kind', () => {
    expect(workingMemoryKindPolicy('member_context')).toMatchObject({
      label: 'Member context',
      preferredScopes: ['member'],
      summaryStyle: 'identity',
    });
    expect(workingMemoryKindPolicy('communication_preference')).toMatchObject({
      preferredScopes: ['member', 'household'],
      reviewAfterDays: 180,
    });
    expect(workingMemoryKindPolicy('convention')).toMatchObject({
      preferredScopes: ['household'],
      conflictPolicy: 'manual_review',
    });
    expect(workingMemoryKindPolicy('other').summaryStyle).toBe('legacy');
  });

  it('normalizes summaries without rewriting words', () => {
    expect(normalizeWorkingMemorySummary('  Prefer   concise\n updates.  ')).toBe('Prefer concise updates.');
  });

  it('sorts object keys recursively and preserves array order', () => {
    expect(canonicalizeWorkingMemoryValue({
      z: { b: 1, a: 2 },
      a: [{ z: true, a: false }, 'second'],
    })).toEqual({
      a: [{ a: false, z: true }, 'second'],
      z: { a: 2, b: 1 },
    });
  });

  it('rejects dangerous keys at any nested level', () => {
    for (const key of ['__proto__', 'prototype', 'constructor']) {
      expect(() => canonicalizeWorkingMemoryValue({ nested: { [key]: 'blocked' } })).toThrow(key);
    }
  });

  it('fingerprints identity fields and canonical values but not summaries or lifecycle', () => {
    const first = workingMemoryEntryFingerprint({
      kind: 'goal',
      scope: 'household',
      value: { goal: 'save', fields: { b: 2, a: 1 } },
    });
    const same = workingMemoryEntryFingerprint({
      kind: 'goal',
      scope: 'household',
      value: { fields: { a: 1, b: 2 }, goal: 'save' },
    });
    expect(first).toBe(same);
    expect(first).not.toBe(workingMemoryEntryFingerprint({
      kind: 'goal',
      scope: 'member',
      ownerPrincipalRef: 'telegram:user:1',
      value: { goal: 'save', fields: { a: 1, b: 2 } },
    }));
  });

  it('enforces kind scope policy', () => {
    expect(workingMemoryScopePolicyIssue({ kind: 'member_context', scope: 'household' })).toMatch(/member/);
    expect(workingMemoryScopePolicyIssue({ kind: 'convention', scope: 'member' })).toMatch(/household/);
    expect(workingMemoryScopePolicyIssue({ kind: 'goal', scope: 'member' })).toBeUndefined();
  });
});
