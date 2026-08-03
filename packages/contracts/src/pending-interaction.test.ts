import { describe, expect, it } from 'vitest';
import {
  PendingInteractionDispositionSchemaV1,
  PendingInteractionSchemaV1,
} from './pending-interaction.js';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const conversationId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const proposalId = 'wmproposal_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const entryId = 'wme_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const createdAt = '2026-08-03T10:00:00.000Z';
const expiresAt = '2026-08-03T10:05:00.000Z';
const resolvedAt = '2026-08-03T10:01:00.000Z';

const pendingWorkingMemoryMutation = {
  proposalId,
  householdId,
  conversationId,
  speakerPrincipalRef: 'telegram:user:42',
  mutation: {
    operation: 'create' as const,
    entryId,
    entry: {
      kind: 'goal' as const,
      summary: 'Build a six-month emergency fund.',
      scope: 'household' as const,
      value: { target: 'six months' },
    },
  },
  basedOnRevision: 'a'.repeat(64),
  createdAt,
  expiresAt,
};

const response = {
  schemaName: 'orchestrator-final-response' as const,
  schemaVersion: 1 as const,
  responseId: 'response-2026-08-03-001',
  householdId,
  conversationId,
  body: 'The goal is now in place.',
  policyBoundary: 'personalized_finance' as const,
  citations: [{ label: 'Working Memory confirmation' }],
  assumptions: [],
  freshness: ['Verified from Working Memory.'],
  disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
  unsupportedCapabilities: [],
  recommendationActions: [],
  delivery: { channel: 'telegram' as const, destination: { chatId: 'telegram-chat-42' }, format: 'plain_text' as const },
  responseHash: 'a'.repeat(64),
  createdAt,
};

function interaction(overrides: Record<string, unknown> = {}) {
  return {
    schemaName: 'pending-interaction' as const,
    schemaVersion: 1 as const,
    interactionId: proposalId,
    kind: 'working_memory_confirmation' as const,
    householdId,
    conversationId,
    speakerPrincipalRef: 'telegram:user:42',
    pendingWorkingMemoryMutation,
    status: 'pending' as const,
    version: 0,
    createdAt,
    expiresAt,
    ...overrides,
  };
}

describe('pending interaction contracts', () => {
  it('accepts a valid Working Memory proposal with duplicated scope', () => {
    expect(PendingInteractionSchemaV1.parse(interaction())).toMatchObject({
      status: 'pending',
      version: 0,
    });
  });

  it('rejects scope and timestamp copies that disagree with the proposal', () => {
    expect(() => PendingInteractionSchemaV1.parse(interaction({ householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1L' }))).toThrow();
    expect(() => PendingInteractionSchemaV1.parse(interaction({ conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2L' }))).toThrow();
    expect(() => PendingInteractionSchemaV1.parse(interaction({ createdAt: '2026-08-03T10:00:01.000Z' }))).toThrow();
    expect(() => PendingInteractionSchemaV1.parse(interaction({ expiresAt: '2026-08-03T10:05:01.000Z' }))).toThrow();
  });

  it('requires resolution evidence for terminal states and forbids it while pending', () => {
    expect(() => PendingInteractionSchemaV1.parse(interaction({ resolutionExternalMessageId: 'telegram:42:approve-1' }))).toThrow();
    expect(PendingInteractionSchemaV1.parse(interaction({
      status: 'resolving',
      version: 1,
      resolutionExternalMessageId: 'telegram:42:approve-1',
    }))).toMatchObject({ status: 'resolving' });
    expect(() => PendingInteractionSchemaV1.parse(interaction({
      status: 'resolving',
      version: 1,
      resolutionExternalMessageId: 'telegram:42:approve-1',
      resolutionCode: 'working_memory_mutation_succeeded',
    }))).toThrow();

    const terminal = interaction({
      status: 'applied',
      version: 2,
      resolutionExternalMessageId: 'telegram:42:approve-1',
      resolutionCode: 'working_memory_mutation_succeeded',
      resolutionResponse: response,
      resolvedAt,
    });
    expect(PendingInteractionSchemaV1.parse(terminal).status).toBe('applied');
    const parsedTerminal = PendingInteractionSchemaV1.parse(terminal);
    const withoutResolvedAt = { ...parsedTerminal };
    delete withoutResolvedAt.resolvedAt;
    expect(() => PendingInteractionSchemaV1.parse(withoutResolvedAt)).toThrow();
  });

  it('uses one strict disposition contract for resolution and context switching', () => {
    expect(PendingInteractionDispositionSchemaV1.parse({
      kind: 'resolve',
      decision: 'approve',
    })).toEqual({ kind: 'resolve', decision: 'approve' });
    expect(PendingInteractionDispositionSchemaV1.parse({ kind: 'new_intent' }))
      .toEqual({ kind: 'new_intent' });
    expect(PendingInteractionDispositionSchemaV1.parse({ kind: 'ambiguous' }))
      .toEqual({ kind: 'ambiguous' });
    expect(PendingInteractionDispositionSchemaV1.safeParse('approve').success).toBe(false);
    expect(PendingInteractionDispositionSchemaV1.safeParse({
      kind: 'resolve',
      decision: 'approve',
      extra: true,
    }).success).toBe(false);
  });
});
