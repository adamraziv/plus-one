import { describe, expect, it } from 'vitest';
import { FlexibleWorkingMemorySchema, WorkingMemoryEntryIdSchema, type UtcInstant } from '@plus-one/contracts';
import { parseScheduledWorkingMemoryReviewContext, reviewWorkingMemoryDocument } from '../src/memory/working-memory-review.js';

const principalRef = 'telegram:user:1';
const otherPrincipalRef = 'telegram:user:2';
const duplicateOlder = WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FAV');
const duplicateNewer = WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FAW');
const contradictionId = WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FAX');
const staleId = WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FAZ');
const otherMemberId = WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FB0');
const now = '2026-07-25T10:55:00.000Z' as UtcInstant;

describe('working memory review', () => {
  it('finds exact duplicates and proposes deleting only an unambiguous older entry', () => {
    const document = FlexibleWorkingMemorySchema.parse({
      version: 1,
      entries: {
        [duplicateOlder]: {
          kind: 'member_context',
          summary: 'Save for an emergency fund.',
          scope: 'member',
          ownerPrincipalRef: principalRef,
          value: { goal: 'emergency fund', fields: { a: 1, b: 2 } },
          lifecycle: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        },
        [duplicateNewer]: {
          kind: 'member_context',
          summary: 'Emergency fund goal.',
          scope: 'member',
          ownerPrincipalRef: principalRef,
          value: { fields: { b: 2, a: 1 }, goal: 'emergency fund' },
          lifecycle: { createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
        },
      },
    });
    const report = reviewWorkingMemoryDocument({ document, principalRef, now });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      category: 'duplicate',
      entryIds: [duplicateOlder, duplicateNewer],
      proposedOperation: 'delete',
      basedOnRevision: report.revision,
    });
  });

  it('finds contradictions and scope mismatches but never applies changes', () => {
    const document = FlexibleWorkingMemorySchema.parse({
      version: 1,
      entries: {
        [contradictionId]: {
          kind: 'saving_preference',
          summary: 'Prefer balanced saving.',
          scope: 'member',
          ownerPrincipalRef: principalRef,
          value: { style: 'balanced', cadence: 'monthly' },
          lifecycle: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        },
        [staleId]: {
          kind: 'saving_preference',
          summary: 'Prefer aggressive saving.',
          scope: 'member',
          ownerPrincipalRef: principalRef,
          value: { style: 'aggressive', cadence: 'monthly' },
          lifecycle: { createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
        },
        [otherMemberId]: {
          kind: 'member_context',
          summary: 'Sam context.',
          scope: 'member',
          ownerPrincipalRef: otherPrincipalRef,
          value: { preferredName: 'Sam' },
          lifecycle: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        },
      },
    });
    const report = reviewWorkingMemoryDocument({ document, principalRef, now });
    expect(report.findings.some((finding) => finding.category === 'contradiction')).toBe(true);
    expect(report.findings.some((finding) => finding.entryIds.includes(otherMemberId))).toBe(false);
    expect(report.findings.every((finding) => finding.proposedOperation !== 'delete')).toBe(true);
  });

  it('reports expired and interval-stale entries as non-destructive findings', () => {
    const document = FlexibleWorkingMemorySchema.parse({
      version: 1,
      entries: {
        [staleId]: {
          kind: 'goal',
          summary: 'Finish the renovation.',
          scope: 'household',
          value: { goal: 'renovation' },
          lifecycle: {
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2026-07-01T00:00:00.000Z',
          },
        },
      },
    });
    const report = reviewWorkingMemoryDocument({ document, principalRef, now });
    expect(report.findings).toEqual([expect.objectContaining({
      category: 'stale',
      entryIds: [staleId],
      proposedOperation: 'none',
    })]);
  });

  it('parses only the exact scheduled review context identity', () => {
    const context = parseScheduledWorkingMemoryReviewContext({
      requiredContextSchema: { schemaName: 'working-memory-review-context', schemaVersion: 1 },
      requiredContext: {
        schemaName: 'working-memory-review-context',
        schemaVersion: 1,
        conversationId: 'conversation_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        principalRef,
        mode: 'suggest',
      },
    });
    expect(context.mode).toBe('suggest');
    expect(() => parseScheduledWorkingMemoryReviewContext({
      requiredContextSchema: { schemaName: 'working-memory-review-context', schemaVersion: 1 },
      requiredContext: { ...context, mode: 'apply' },
    })).toThrow();
    expect(() => parseScheduledWorkingMemoryReviewContext({
      requiredContextSchema: { schemaName: 'working-memory-review-context', schemaVersion: 2 },
      requiredContext: context,
    })).toThrow();
  });
});
