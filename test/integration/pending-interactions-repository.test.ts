import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  PostgresPendingInteractionRepository,
  type PendingInteractionRepository,
} from '@plus-one/database';
import {
  OrchestratorFinalResponseSchemaV1,
  PendingInteractionSchemaV1,
} from '@plus-one/contracts';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;

afterEach(async () => {
  await context?.cleanup();
  context = undefined;
});

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const otherHouseholdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1M';
const conversationId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const otherConversationId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1M';
const principalRef = 'telegram:user:42';
const proposalId = 'wmproposal_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const otherProposalId = 'wmproposal_01ARZ3NDEKTSV4RRFFQ69G5FAW';
const createdAt = '2026-08-03T10:00:00.000Z';
const expiresAt = '2026-08-03T10:05:00.000Z';

async function seedHouseholds(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1, 'USD', 'UTC'), ($2, 'USD', 'UTC')`,
    [householdId, otherHouseholdId],
  );
}

function response() {
  return OrchestratorFinalResponseSchemaV1.parse({
    schemaName: 'orchestrator-final-response' as const,
    schemaVersion: 1 as const,
    responseId: 'response-2026-08-03-pending-1',
    householdId,
    conversationId,
    body: 'The language preference was saved and verified.',
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
  });
}

function candidate(overrides: {
  interactionId?: string;
  householdId?: string;
  conversationId?: string;
  speakerPrincipalRef?: string;
  proposalId?: string;
} = {}) {
  const interactionId = overrides.interactionId ?? proposalId;
  const pendingProposalId = overrides.proposalId ?? interactionId;
  const pending = {
    proposalId: pendingProposalId,
    householdId: overrides.householdId ?? householdId,
    conversationId: overrides.conversationId ?? conversationId,
    speakerPrincipalRef: overrides.speakerPrincipalRef ?? principalRef,
    mutation: {
      operation: 'create' as const,
      entryId: 'wme_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      entry: {
        kind: 'communication_preference' as const,
        summary: 'Use concise replies.',
        scope: 'household' as const,
        value: { detail: 'concise' },
      },
    },
    basedOnRevision: 'a'.repeat(64),
    createdAt,
    expiresAt,
  };
  return PendingInteractionSchemaV1.parse({
    schemaName: 'pending-interaction' as const,
    schemaVersion: 1 as const,
    interactionId,
    kind: 'working_memory_confirmation' as const,
    householdId: overrides.householdId ?? householdId,
    conversationId: overrides.conversationId ?? conversationId,
    speakerPrincipalRef: overrides.speakerPrincipalRef ?? principalRef,
    pendingWorkingMemoryMutation: pending,
    status: 'pending' as const,
    version: 0,
    createdAt,
    expiresAt,
  });
}

async function setup(label: string): Promise<{ pool: Pool; repository: PendingInteractionRepository }> {
  context = await createPostgresTestContext(label);
  const pool = new Pool({ connectionString: context.roleUrls.operations });
  await seedHouseholds(pool);
  return { pool, repository: new PostgresPendingInteractionRepository(pool) };
}

describe('PostgresPendingInteractionRepository', () => {
  it('creates idempotently and isolates open lookups by authenticated scope', async () => {
    const { pool, repository } = await setup('pending_interactions_create');
    try {
      const first = await repository.create(candidate());
      const replay = await repository.create(candidate());
      expect(replay).toEqual(first);
      await expect(repository.create(candidate({ interactionId: otherProposalId }))).rejects.toMatchObject({
        code: 'pending_interaction_scope_conflict',
      });

      await expect(repository.findOpen({ householdId, conversationId, speakerPrincipalRef: principalRef }))
        .resolves.toMatchObject({ interactionId: proposalId });
      await expect(repository.findOpen({ householdId, conversationId, speakerPrincipalRef: 'telegram:user:99' }))
        .resolves.toBeUndefined();
      await expect(repository.findOpen({ householdId, conversationId: otherConversationId, speakerPrincipalRef: principalRef }))
        .resolves.toBeUndefined();
      await expect(repository.findOpen({ householdId: otherHouseholdId, conversationId, speakerPrincipalRef: principalRef }))
        .resolves.toBeUndefined();
    } finally {
      await pool.end();
    }
  });

  it('claims atomically, replays the same message, conflicts on a competing message, and reads terminal state after restart', async () => {
    const { pool, repository } = await setup('pending_interactions_lifecycle');
    try {
      await repository.create(candidate());

      const claimed = await repository.claim({
        interactionId: proposalId,
        householdId,
        externalMessageId: 'telegram:42:approve-1',
        expectedVersion: 0,
      });
      expect(claimed.kind).toBe('claimed');
      expect(claimed.interaction).toMatchObject({ status: 'resolving', version: 1 });

      await expect(repository.claim({
        interactionId: proposalId,
        householdId,
        externalMessageId: 'telegram:42:approve-1',
        expectedVersion: 0,
      })).resolves.toMatchObject({ kind: 'replay' });
      await expect(repository.claim({
        interactionId: proposalId,
        householdId,
        externalMessageId: 'telegram:42:approve-2',
        expectedVersion: 0,
      })).rejects.toMatchObject({ code: 'pending_interaction_state_conflict' });

      const terminal = await repository.complete({
        interactionId: proposalId,
        householdId,
        expectedVersion: 1,
        status: 'applied',
        resolutionCode: 'working_memory_mutation_succeeded',
        resolutionResponse: response(),
        resolvedAt: '2026-08-03T10:01:00.000Z',
      });
      expect(terminal).toMatchObject({ status: 'applied', version: 2 });
      await expect(repository.findById({ householdId, interactionId: proposalId }))
        .resolves.toMatchObject({ status: 'applied' });
      await expect(repository.findByResolutionMessage({
        householdId,
        conversationId,
        externalMessageId: 'telegram:42:approve-1',
      })).resolves.toMatchObject({ status: 'applied', resolutionResponse: response() });

      const restartedRepository = new PostgresPendingInteractionRepository(pool);
      await expect(restartedRepository.findByResolutionMessage({
        householdId,
        conversationId,
        externalMessageId: 'telegram:42:approve-1',
      })).resolves.toMatchObject({ status: 'applied' });
    } finally {
      await pool.end();
    }
  });
});
