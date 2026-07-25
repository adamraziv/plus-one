import { describe, expect, it, vi } from 'vitest';
import {
  FlexibleWorkingMemorySchema,
  WorkingMemoryEntryIdSchema,
  WorkingMemoryProposalIdSchema,
  type PendingWorkingMemoryMutation,
  type WorkingMemoryInspectionResult,
  type WorkingMemoryMutationToolResult,
} from '@plus-one/contracts';
import type { InboundChannelMessageV1 } from '@plus-one/contracts';
import type {
  OrchestratorSessionMemoryPort,
  WorkingMemoryMutationOutcome,
  WorkingMemoryOperationOutcome,
} from '../memory/orchestrator-session-memory.js';
import { workingMemoryRevision } from '../memory/working-memory-document.js';
import { createInspectWorkingMemoryTool, createMutateWorkingMemoryTool, type WorkingMemoryInspectionContext } from './working-memory.js';

const message = {
  conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  speaker: { principalRef: 'telegram:user:1' },
} as InboundChannelMessageV1;
const goalId = WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FAV');
const newId = WorkingMemoryEntryIdSchema.parse('wme_01ARZ3NDEKTSV4RRFFQ69G5FAW');
const proposalId = WorkingMemoryProposalIdSchema.parse('wmproposal_01ARZ3NDEKTSV4RRFFQ69G5FAV');

function activeInvocation(workingMemoryInspection?: WorkingMemoryInspectionContext) {
  return {
    message,
    signal: new AbortController().signal,
    ...(workingMemoryInspection === undefined ? {} : { workingMemoryInspection }),
  };
}

function workingMemoryDocument(withGoal = false) {
  return FlexibleWorkingMemorySchema.parse({
    version: 1,
    entries: withGoal ? {
      [goalId]: {
        kind: 'goal',
        summary: 'Buy a BMW X5.',
        scope: 'household',
        value: { goal: 'BMW X5' },
      },
    } : {},
  });
}

function inspectionFor(document: ReturnType<typeof workingMemoryDocument>): WorkingMemoryInspectionContext {
  const inspection: WorkingMemoryInspectionResult = {
    revision: workingMemoryRevision(document),
    entries: Object.entries(document.entries).map(([entryId, entry]) => ({
      entryId: WorkingMemoryEntryIdSchema.parse(entryId),
      kind: entry.kind,
      summary: entry.summary,
      scope: entry.scope,
      value: entry.value,
    })),
  };
  return { ...inspection, document };
}

function successOutcome(operation: 'inspect' | 'validate' | 'mutate', code: string): WorkingMemoryOperationOutcome {
  return { operation, status: 'succeeded', code };
}

function fakeMemory(overrides: Partial<OrchestratorSessionMemoryPort> = {}) {
  return {
    inspectWorkingMemory: vi.fn(async () => {
      const document = workingMemoryDocument();
      return {
        status: 'succeeded' as const,
        document,
        inspection: inspectionFor(document),
        outcome: successOutcome('inspect', 'working_memory_inspection_succeeded'),
      };
    }),
    validateWorkingMemoryMutation: vi.fn(async (input) => ({
      status: 'succeeded' as const,
      operation: input.mutation.operation,
      code: 'working_memory_mutation_validated' as const,
      document: workingMemoryDocument(),
      outcome: successOutcome('validate', 'working_memory_mutation_validated'),
    })),
    applyWorkingMemoryMutation: vi.fn(async (input) => ({
      status: 'succeeded' as const,
      operation: input.mutation.operation,
      code: 'working_memory_mutation_succeeded' as const,
      document: workingMemoryDocument(),
      outcome: successOutcome('mutate', 'working_memory_mutation_succeeded'),
    })),
    ...overrides,
  } as unknown as OrchestratorSessionMemoryPort;
}

async function executeTool(tool: unknown, input: unknown = {}) {
  const executable = tool as { execute?: (input: unknown, context: unknown) => unknown };
  return executable.execute?.(input, {});
}

describe('createInspectWorkingMemoryTool', () => {
  it('derives authenticated scope from the active invocation and records only a successful inspection', async () => {
    const document = workingMemoryDocument();
    const inspection = inspectionFor(document);
    const memory = fakeMemory({
      inspectWorkingMemory: vi.fn(async () => ({
        status: 'succeeded' as const,
        document,
        inspection,
        outcome: successOutcome('inspect', 'working_memory_inspection_succeeded'),
      })),
    });
    const recordInspection = vi.fn();
    const recordOutcome = vi.fn();
    const tool = createInspectWorkingMemoryTool({
      memory,
      getActiveInvocation: () => activeInvocation(),
      recordInspection,
      recordOutcome,
    });

    await expect(executeTool(tool)).resolves.toEqual({
      status: 'succeeded',
      revision: inspection.revision,
      entries: inspection.entries,
    });
    expect(memory.inspectWorkingMemory).toHaveBeenCalledWith({
      threadId: message.conversationId,
      resourceId: message.householdId,
      principalRef: message.speaker.principalRef,
    });
    expect(recordInspection).toHaveBeenCalledWith(inspection);
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ operation: 'inspect' }));
  });

  it('returns a safe failure and records no revision when there is no active invocation', async () => {
    const recordInspection = vi.fn();
    const tool = createInspectWorkingMemoryTool({
      memory: fakeMemory(),
      getActiveInvocation: () => undefined,
      recordInspection,
    });

    await expect(executeTool(tool)).resolves.toMatchObject({
      status: 'failed',
      code: 'working_memory_inspection_failed',
    });
    expect(recordInspection).not.toHaveBeenCalled();
  });
});

describe('createMutateWorkingMemoryTool', () => {
  it('requires a same-turn inspection and the exact inspected revision', async () => {
    const memory = fakeMemory();
    const tool = createMutateWorkingMemoryTool({
      memory,
      ids: { nextEntryId: () => newId, nextProposalId: () => proposalId },
      now: () => new Date('2026-07-25T10:55:00Z'),
      getActiveInvocation: () => activeInvocation(),
      recordPendingMutation: vi.fn(),
      recordOutcome: vi.fn(),
    });
    const draft = {
      operation: 'create',
      basedOnRevision: 'a'.repeat(64),
      kind: 'goal',
      summary: 'Buy a BMW X5.',
      scope: 'household',
      value: { goal: 'BMW X5' },
    };

    await expect(executeTool(tool, draft)).resolves.toMatchObject({
      status: 'rejected',
      code: 'working_memory_inspection_required',
    });
    expect(memory.applyWorkingMemoryMutation).not.toHaveBeenCalled();
  });

  it('applies an unambiguous create with a server-issued ID only after adapter verification', async () => {
    const document = workingMemoryDocument();
    const inspection = inspectionFor(document);
    const applied: WorkingMemoryMutationOutcome = {
      status: 'succeeded',
      operation: 'create',
      code: 'working_memory_mutation_succeeded',
      document,
      outcome: successOutcome('mutate', 'working_memory_mutation_succeeded'),
    };
    const applyWorkingMemoryMutation = vi.fn(async () => applied);
    const memory = fakeMemory({ applyWorkingMemoryMutation });
    const tool = createMutateWorkingMemoryTool({
      memory,
      ids: { nextEntryId: () => newId, nextProposalId: () => proposalId },
      now: () => new Date('2026-07-25T10:55:00Z'),
      getActiveInvocation: () => activeInvocation(inspection),
      recordPendingMutation: vi.fn(),
      recordOutcome: vi.fn(),
    });

    const result = await executeTool(tool, {
      operation: 'create',
      basedOnRevision: inspection.revision,
      kind: 'goal',
      summary: 'Buy a BMW X5.',
      scope: 'household',
      value: { goal: 'BMW X5' },
    });

    expect(result).toEqual({ status: 'applied', operation: 'create', code: 'working_memory_mutation_succeeded' });
    expect(applyWorkingMemoryMutation).toHaveBeenCalledWith(expect.objectContaining({
      threadId: message.conversationId,
      resourceId: message.householdId,
      principalRef: message.speaker.principalRef,
      basedOnRevision: inspection.revision,
      mutation: {
        operation: 'create',
        entryId: newId,
        entry: expect.objectContaining({ scope: 'household' }),
      },
    }));
  });

  it('creates a pending proposal for duplicate create, replace, delete, and clear without writing', async () => {
    const document = workingMemoryDocument(true);
    const inspection = inspectionFor(document);
    const validateWorkingMemoryMutation = vi.fn(async (input) => ({
      status: 'succeeded' as const,
      operation: input.mutation.operation,
      code: 'working_memory_mutation_validated' as const,
      document,
      outcome: successOutcome('validate', 'working_memory_mutation_validated'),
    }));
    const recordPendingMutation = vi.fn<(proposal: PendingWorkingMemoryMutation) => void>();
    const memory = fakeMemory({ validateWorkingMemoryMutation });
    const tool = createMutateWorkingMemoryTool({
      memory,
      ids: { nextEntryId: () => newId, nextProposalId: () => proposalId },
      now: () => new Date('2026-07-25T10:55:00Z'),
      getActiveInvocation: () => activeInvocation(inspection),
      recordPendingMutation,
    });

    const result = await executeTool(tool, {
      operation: 'replace',
      basedOnRevision: inspection.revision,
      entryId: goalId,
      kind: 'goal',
      summary: 'Buy a BMW X7.',
      value: { goals: ['BMW X7'] },
    }) as WorkingMemoryMutationToolResult;

    expect(result).toEqual({ status: 'confirmation_required', operation: 'replace', code: 'working_memory_confirmation_required' });
    expect(recordPendingMutation).toHaveBeenCalledOnce();
    expect(recordPendingMutation.mock.calls[0]![0]).toMatchObject({
      proposalId,
      householdId: message.householdId,
      conversationId: message.conversationId,
      speakerPrincipalRef: message.speaker.principalRef,
      basedOnRevision: inspection.revision,
      mutation: { operation: 'replace', entryId: goalId },
      createdAt: '2026-07-25T10:55:00.000Z',
      expiresAt: '2026-07-25T11:10:00.000Z',
    });
    expect(memory.applyWorkingMemoryMutation).not.toHaveBeenCalled();
  });

  it('returns adapter staleness and strips model envelope fields', async () => {
    const document = workingMemoryDocument(true);
    const inspection = inspectionFor(document);
    const validateWorkingMemoryMutation = vi.fn(async () => ({
      status: 'failed' as const,
      operation: 'replace' as const,
      code: 'working_memory_revision_stale',
      category: 'serialization_conflict' as const,
      retry: 'after_state_resolution' as const,
      outcome: {
        operation: 'mutate' as const,
        status: 'failed' as const,
        code: 'working_memory_revision_stale',
        category: 'serialization_conflict' as const,
        retry: 'after_state_resolution' as const,
      },
    }));
    const recordPendingMutation = vi.fn();
    const tool = createMutateWorkingMemoryTool({
      memory: fakeMemory({ validateWorkingMemoryMutation }),
      ids: { nextEntryId: () => newId, nextProposalId: () => proposalId },
      now: () => new Date('2026-07-25T10:55:00Z'),
      getActiveInvocation: () => activeInvocation(inspection),
      recordPendingMutation,
    });

    await expect(executeTool(tool, {
      operation: 'replace',
      basedOnRevision: inspection.revision,
      entryId: goalId,
      kind: 'goal',
      summary: 'Buy a BMW X7.',
      value: { goal: 'BMW X7' },
    })).resolves.toMatchObject({ status: 'rejected', code: 'working_memory_revision_stale' });
    expect(recordPendingMutation).not.toHaveBeenCalled();

    await expect(executeTool(tool, {
      operation: 'replace',
      basedOnRevision: inspection.revision,
      entryId: goalId,
      kind: 'goal',
      summary: 'Buy a BMW X7.',
      value: { goal: 'BMW X7' },
      resourceId: 'other-household',
    })).resolves.toMatchObject({ status: 'rejected', code: 'working_memory_revision_stale' });
  });

  it('uses the inspected revision when a model sends a noncanonical revision', async () => {
    const document = workingMemoryDocument();
    const inspection = inspectionFor(document);
    const applyWorkingMemoryMutation = vi.fn(async () => ({
      status: 'succeeded' as const,
      operation: 'create' as const,
      code: 'working_memory_mutation_succeeded' as const,
      document,
      outcome: successOutcome('mutate', 'working_memory_mutation_succeeded'),
    }));
    const memory = fakeMemory({ applyWorkingMemoryMutation });
    const tool = createMutateWorkingMemoryTool({
      memory,
      ids: { nextEntryId: () => newId, nextProposalId: () => proposalId },
      now: () => new Date('2026-07-25T10:55:00Z'),
      getActiveInvocation: () => activeInvocation(inspection),
      recordPendingMutation: vi.fn(),
    });

    await expect(executeTool(tool, {
      operation: 'create',
      basedOnRevision: 'model-revision',
      kind: 'goal',
      summary: 'Buy a BMW X5.',
      scope: 'household',
      value: JSON.stringify({ goal: 'BMW X5' }),
      scopeHint: 'household',
    })).resolves.toEqual({ status: 'applied', operation: 'create', code: 'working_memory_mutation_succeeded' });
    expect(applyWorkingMemoryMutation).toHaveBeenCalledWith(expect.objectContaining({
      basedOnRevision: inspection.revision,
    }));
  });
});
