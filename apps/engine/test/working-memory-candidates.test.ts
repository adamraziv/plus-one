import { describe, expect, it } from 'vitest';
import { WorkingMemoryEntryIdSchema } from '@plus-one/contracts';
import { createWorkingMemoryCandidate } from '../src/memory/working-memory-candidates.js';

const principalRef = 'telegram:user:1';
const entryId = WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FAV');
const revision = 'a'.repeat(64);

describe('working memory candidates', () => {
  it('derives member scope from self without exposing the owner', () => {
    const result = createWorkingMemoryCandidate({
      principalRef,
      inspectedRevision: revision,
      draft: {
        kind: 'communication_preference',
        summary: '  Prefer   concise updates. ',
        value: { detail: 'concise' },
        signal: 'preference_signal',
        subject: 'self',
      },
    });
    expect(result).toMatchObject({ status: 'succeeded', operation: 'create', candidate: { scope: 'member', summary: 'Prefer concise updates.' } });
    expect(JSON.stringify(result)).not.toContain(principalRef);
  });

  it('derives household scope and rejects policy-incompatible kinds', () => {
    expect(createWorkingMemoryCandidate({
      principalRef,
      draft: {
        kind: 'goal', summary: 'Build an emergency fund.', value: { goal: 'emergency fund' }, signal: 'explicit_request', subject: 'household',
      },
    })).toMatchObject({ status: 'succeeded', candidate: { scope: 'household' } });
    expect(createWorkingMemoryCandidate({
      principalRef,
      draft: {
        kind: 'member_context', summary: 'I prefer Alex.', value: { preferredName: 'Alex' }, signal: 'preference_signal', subject: 'household',
      },
    })).toEqual({ status: 'failed', code: 'working_memory_candidate_scope_invalid' });
    expect(createWorkingMemoryCandidate({
      principalRef,
      draft: {
        kind: 'convention', summary: 'Use Groceries.', value: { category: 'Groceries' }, signal: 'preference_signal', subject: 'self',
      },
    })).toEqual({ status: 'failed', code: 'working_memory_candidate_scope_invalid' });
  });

  it('resolves a correction only against one authorized visible entry', () => {
    const result = createWorkingMemoryCandidate({
      principalRef,
      inspectedRevision: revision,
      visibleEntries: [{
        entryId,
        kind: 'communication_preference',
        summary: 'Prefer concise updates.',
        scope: 'member',
        value: { detail: 'concise' },
      }],
      draft: {
        kind: 'communication_preference',
        summary: 'Prefer detailed updates.',
        value: { detail: 'detailed' },
        signal: 'correction_signal',
        subject: 'self',
        correctionTarget: { kind: 'communication_preference', summary: 'Prefer concise updates.' },
      },
    });
    expect(result).toMatchObject({ status: 'succeeded', operation: 'replace', targetEntryId: entryId });
    expect(createWorkingMemoryCandidate({
      principalRef,
      visibleEntries: [],
      draft: {
        kind: 'communication_preference', summary: 'Prefer detailed updates.', value: { detail: 'detailed' }, signal: 'correction_signal', subject: 'self', correctionTarget: { kind: 'communication_preference', summary: 'missing' },
      },
    })).toEqual({ status: 'failed', code: 'working_memory_candidate_target_not_found' });
  });
});
