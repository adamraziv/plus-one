import {
  OrchestratorFinalResponseSchemaV1,
  PendingInteractionSchemaV1,
  PlusOneError,
  type OrchestratorFinalResponseV1,
  type PendingInteractionV1,
} from '@plus-one/contracts';
import type { Pool, QueryResultRow } from 'pg';

export interface PendingInteractionRepository {
  create(candidate: PendingInteractionV1): Promise<PendingInteractionV1>;
  findOpen(input: {
    householdId: string;
    conversationId: string;
    speakerPrincipalRef: string;
  }): Promise<PendingInteractionV1 | undefined>;
  findById(input: {
    householdId: string;
    interactionId: string;
  }): Promise<PendingInteractionV1 | undefined>;
  findByResolutionMessage(input: {
    householdId: string;
    conversationId: string;
    externalMessageId: string;
  }): Promise<PendingInteractionV1 | undefined>;
  claim(input: {
    householdId: string;
    interactionId: string;
    externalMessageId: string;
    expectedVersion: number;
  }): Promise<PendingInteractionClaimResult>;
  complete(input: {
    householdId: string;
    interactionId: string;
    expectedVersion: number;
    status: 'applied' | 'rejected' | 'expired' | 'stale' | 'failed';
    resolutionCode: string;
    resolutionResponse: OrchestratorFinalResponseV1;
    resolvedAt: string;
  }): Promise<PendingInteractionV1>;
}

export type PendingInteractionClaimResult =
  | { kind: 'claimed'; interaction: PendingInteractionV1 }
  | { kind: 'replay'; interaction: PendingInteractionV1 };

interface PendingInteractionRow extends QueryResultRow {
  interaction_id: string;
  kind: string;
  household_id?: string;
  conversation_id: string;
  speaker_principal_ref: string;
  payload: unknown;
  status: string;
  version: string | number;
  resolution_external_message_id: string | null;
  resolution_code: string | null;
  resolution_response: unknown;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
}

const pendingInteractionColumns = `
  interaction.interaction_id,
  interaction.kind,
  household.household_id AS household_id,
  interaction.conversation_id,
  interaction.speaker_principal_ref,
  interaction.payload,
  interaction.status,
  interaction.version::text,
  interaction.resolution_external_message_id,
  interaction.resolution_code,
  interaction.resolution_response,
  to_char(interaction.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  to_char(interaction.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
  CASE WHEN interaction.resolved_at IS NULL THEN NULL
    ELSE to_char(interaction.resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  END AS resolved_at`;

export class PostgresPendingInteractionRepository implements PendingInteractionRepository {
  constructor(private readonly pool: Pool) {}

  async create(candidate: PendingInteractionV1): Promise<PendingInteractionV1> {
    const input = PendingInteractionSchemaV1.parse(candidate);
    try {
      const inserted = await this.pool.query<PendingInteractionRow>(
        `INSERT INTO operations.pending_interactions
         (interaction_id, kind, household_id, conversation_id, speaker_principal_ref,
          payload, status, version, created_at, expires_at)
         SELECT $1, $2, household.id, $3, $4, $5::jsonb, $6, $7, $8::timestamptz, $9::timestamptz
         FROM operations.households household
         WHERE household.household_id = $10
         ON CONFLICT (interaction_id) DO NOTHING
         RETURNING interaction_id, kind, conversation_id, speaker_principal_ref,
           payload, status, version::text,
           resolution_external_message_id, resolution_code, resolution_response,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
           to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
           NULL::text AS resolved_at`,
        [
          input.interactionId,
          input.kind,
          input.conversationId,
          input.speakerPrincipalRef,
          JSON.stringify(input.pendingWorkingMemoryMutation),
          input.status,
          input.version,
          input.createdAt,
          input.expiresAt,
          input.householdId,
        ],
      );
      const row = inserted.rows[0];
      if (row !== undefined) return mapPendingInteraction(row, input.householdId);

      const existing = await this.findById({
        householdId: input.householdId,
        interactionId: input.interactionId,
      });
      if (existing !== undefined) {
        if (stableJson(existing) === stableJson(input)) return existing;
        throw this.idempotencyConflict(input.interactionId);
      }
      throw this.householdNotFound(input.householdId);
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === '23505' && failure.constraint === 'pending_interactions_open_scope_unique') {
        throw new PlusOneError({
          category: 'serialization_conflict',
          code: 'pending_interaction_scope_conflict',
          message: 'An open Working Memory confirmation already exists for this authenticated scope.',
          retry: 'after_state_resolution',
          receiptLookupRequired: true,
          details: { householdId: input.householdId, conversationId: input.conversationId },
          cause: error,
        });
      }
      throw error;
    }
  }

  async findOpen(input: {
    householdId: string;
    conversationId: string;
    speakerPrincipalRef: string;
  }): Promise<PendingInteractionV1 | undefined> {
    const result = await this.pool.query<PendingInteractionRow>(
      `SELECT ${pendingInteractionColumns}
       FROM operations.pending_interactions interaction
       JOIN operations.households household ON household.id = interaction.household_id
       WHERE household.household_id = $1
         AND interaction.conversation_id = $2
         AND interaction.speaker_principal_ref = $3
         AND interaction.status IN ('pending', 'resolving')
       ORDER BY interaction.id DESC
       LIMIT 1`,
      [input.householdId, input.conversationId, input.speakerPrincipalRef],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapPendingInteraction(row);
  }

  async findById(input: {
    householdId: string;
    interactionId: string;
  }): Promise<PendingInteractionV1 | undefined> {
    const result = await this.pool.query<PendingInteractionRow>(
      `SELECT ${pendingInteractionColumns}
       FROM operations.pending_interactions interaction
       JOIN operations.households household ON household.id = interaction.household_id
       WHERE household.household_id = $1
         AND interaction.interaction_id = $2`,
      [input.householdId, input.interactionId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapPendingInteraction(row);
  }

  async findByResolutionMessage(input: {
    householdId: string;
    conversationId: string;
    externalMessageId: string;
  }): Promise<PendingInteractionV1 | undefined> {
    const result = await this.pool.query<PendingInteractionRow>(
      `SELECT ${pendingInteractionColumns}
       FROM operations.pending_interactions interaction
       JOIN operations.households household ON household.id = interaction.household_id
       WHERE household.household_id = $1
         AND interaction.conversation_id = $2
         AND interaction.resolution_external_message_id = $3`,
      [input.householdId, input.conversationId, input.externalMessageId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapPendingInteraction(row);
  }

  async claim(input: {
    householdId: string;
    interactionId: string;
    externalMessageId: string;
    expectedVersion: number;
  }): Promise<PendingInteractionClaimResult> {
    const claimed = await this.pool.query<PendingInteractionRow>(
      `UPDATE operations.pending_interactions interaction
       SET status = 'resolving', version = version + 1,
           resolution_external_message_id = $1, updated_at = clock_timestamp()
       FROM operations.households household
       WHERE household.id = interaction.household_id
         AND household.household_id = $2
         AND interaction.interaction_id = $3
         AND interaction.status = 'pending'
         AND interaction.version = $4
       RETURNING interaction.interaction_id, interaction.kind,
         interaction.conversation_id, interaction.speaker_principal_ref,
         interaction.payload, interaction.status, interaction.version::text,
         interaction.resolution_external_message_id, interaction.resolution_code,
         interaction.resolution_response,
         to_char(interaction.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
         to_char(interaction.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
         NULL::text AS resolved_at`,
      [input.externalMessageId, input.householdId, input.interactionId, input.expectedVersion],
    );
    const row = claimed.rows[0];
    if (row !== undefined) {
      return { kind: 'claimed', interaction: mapPendingInteraction(row, input.householdId) };
    }

    const existing = await this.findById({
      householdId: input.householdId,
      interactionId: input.interactionId,
    });
    if (existing === undefined) throw this.notFound(input.interactionId);
    if (existing.resolutionExternalMessageId === input.externalMessageId) {
      return { kind: 'replay', interaction: existing };
    }
    throw this.stateConflict(input.interactionId, input.expectedVersion);
  }

  async complete(input: {
    householdId: string;
    interactionId: string;
    expectedVersion: number;
    status: 'applied' | 'rejected' | 'expired' | 'stale' | 'failed';
    resolutionCode: string;
    resolutionResponse: OrchestratorFinalResponseV1;
    resolvedAt: string;
  }): Promise<PendingInteractionV1> {
    const response = OrchestratorFinalResponseSchemaV1.parse(input.resolutionResponse);
    const result = await this.pool.query<PendingInteractionRow>(
      `UPDATE operations.pending_interactions interaction
       SET status = $1, version = version + 1,
           resolution_code = $2, resolution_response = $3::jsonb,
           resolved_at = $4::timestamptz, updated_at = clock_timestamp()
       FROM operations.households household
       WHERE household.id = interaction.household_id
         AND household.household_id = $5
         AND interaction.interaction_id = $6
         AND interaction.status = 'resolving'
         AND interaction.version = $7
       RETURNING interaction.interaction_id, interaction.kind,
         interaction.conversation_id, interaction.speaker_principal_ref,
         interaction.payload, interaction.status, interaction.version::text,
         interaction.resolution_external_message_id, interaction.resolution_code,
         interaction.resolution_response,
         to_char(interaction.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
         to_char(interaction.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
         to_char(interaction.resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS resolved_at`,
      [
        input.status,
        input.resolutionCode,
        JSON.stringify(response),
        input.resolvedAt,
        input.householdId,
        input.interactionId,
        input.expectedVersion,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw this.stateConflict(input.interactionId, input.expectedVersion);
    return mapPendingInteraction(row, input.householdId);
  }

  private idempotencyConflict(interactionId: string): PlusOneError {
    return new PlusOneError({
      category: 'duplicate_replay',
      code: 'pending_interaction_idempotency_conflict',
      message: 'Interaction ID is already bound to a different pending interaction.',
      retry: 'never',
      receiptLookupRequired: true,
      details: { interactionId },
    });
  }

  private householdNotFound(householdId: string): PlusOneError {
    return new PlusOneError({
      category: 'validation_rejected',
      code: 'pending_interaction_household_not_found',
      message: 'Pending interaction household was not found.',
      retry: 'never',
      receiptLookupRequired: false,
      details: { householdId },
    });
  }

  private notFound(interactionId: string): PlusOneError {
    return new PlusOneError({
      category: 'validation_rejected',
      code: 'pending_interaction_not_found',
      message: 'Pending interaction was not found in the authenticated household.',
      retry: 'never',
      receiptLookupRequired: false,
      details: { interactionId },
    });
  }

  private stateConflict(interactionId: string, expectedVersion: number): PlusOneError {
    return new PlusOneError({
      category: 'serialization_conflict',
      code: 'pending_interaction_state_conflict',
      message: 'Pending interaction state changed before the operation completed.',
      retry: 'after_state_resolution',
      receiptLookupRequired: true,
      details: { interactionId, expectedVersion },
    });
  }
}

function mapPendingInteraction(row: PendingInteractionRow, householdId = row.household_id): PendingInteractionV1 {
  if (householdId === undefined) throw new Error('Pending interaction row omitted household scope.');
  return PendingInteractionSchemaV1.parse({
    schemaName: 'pending-interaction',
    schemaVersion: 1,
    interactionId: row.interaction_id,
    kind: row.kind,
    householdId,
    conversationId: row.conversation_id,
    speakerPrincipalRef: row.speaker_principal_ref,
    pendingWorkingMemoryMutation: row.payload,
    status: row.status,
    version: Number(row.version),
    ...(row.resolution_external_message_id === null ? {} : {
      resolutionExternalMessageId: row.resolution_external_message_id,
    }),
    ...(row.resolution_code === null ? {} : { resolutionCode: row.resolution_code }),
    ...(row.resolution_response === null ? {} : { resolutionResponse: row.resolution_response }),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
