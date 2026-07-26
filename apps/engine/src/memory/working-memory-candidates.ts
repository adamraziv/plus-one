import {
  WorkingMemoryCandidateInputSchema,
  WorkingMemoryCandidateSchema,
  type WorkingMemoryCandidate,
  type WorkingMemoryCandidateInput,
  type WorkingMemoryInspectionResult,
  type WorkingMemoryRevision,
} from '@plus-one/contracts';
import {
  normalizeWorkingMemorySummary,
  workingMemoryScopePolicyIssue,
} from './working-memory-taxonomy.js';

export type WorkingMemoryCandidateResult =
  | {
      status: 'succeeded';
      operation: 'create' | 'replace';
      candidate: WorkingMemoryCandidate;
      targetEntryId?: WorkingMemoryInspectionResult['entries'][number]['entryId'];
    }
  | {
      status: 'failed';
      code:
        | 'working_memory_candidate_invalid'
        | 'working_memory_candidate_scope_invalid'
        | 'working_memory_candidate_target_not_found'
        | 'working_memory_candidate_target_ambiguous';
    };

export function createWorkingMemoryCandidate(input: {
  draft: WorkingMemoryCandidateInput;
  principalRef: string;
  inspectedRevision?: WorkingMemoryRevision;
  visibleEntries?: WorkingMemoryInspectionResult['entries'];
}): WorkingMemoryCandidateResult {
  void input.principalRef;
  const parsed = WorkingMemoryCandidateInputSchema.safeParse(input.draft);
  if (!parsed.success) return { status: 'failed', code: 'working_memory_candidate_invalid' };
  const draft = parsed.data;
  const scope = draft.subject === 'self' ? 'member' : 'household';
  if (workingMemoryScopePolicyIssue({ kind: draft.kind, scope }) !== undefined) {
    return { status: 'failed', code: 'working_memory_candidate_scope_invalid' };
  }

  const candidate = WorkingMemoryCandidateSchema.parse({
    kind: draft.kind,
    summary: normalizeWorkingMemorySummary(draft.summary),
    scope,
    value: draft.value,
    signal: draft.signal,
    ...(input.inspectedRevision === undefined ? {} : { inspectedRevision: input.inspectedRevision }),
  });

  if (draft.signal !== 'correction_signal') {
    return { status: 'succeeded', operation: 'create', candidate };
  }

  const visibleEntries = input.visibleEntries ?? [];
  const matches = visibleEntries.filter((entry) => (
    draft.correctionTarget !== undefined
      && entry.kind === draft.correctionTarget.kind
      && normalizeWorkingMemorySummary(entry.summary) === normalizeWorkingMemorySummary(draft.correctionTarget.summary)
  ));
  if (matches.length === 0) return { status: 'failed', code: 'working_memory_candidate_target_not_found' };
  if (matches.length !== 1) return { status: 'failed', code: 'working_memory_candidate_target_ambiguous' };
  return {
    status: 'succeeded',
    operation: 'replace',
    candidate,
    targetEntryId: matches[0]!.entryId,
  };
}
