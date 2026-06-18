import {
  CheckedCommandSchemaV1,
  ExternalConfirmationSchemaV1,
  MutationReceiptSchemaV1,
  PlusOneError,
  ReadbackResultSchemaV1,
  type CheckedCommandV1,
  type CommandStatusV1,
  type ExternalConfirmationV1,
  type JsonValue,
  type MutationReceiptV1,
  type ReadbackResultV1,
} from '@plus-one/contracts';
import type { Pool } from 'pg';
import { normalizeDatabaseError } from '../../errors.js';

export interface MutationCommandRecord {
  commandId: string;
  householdId: string;
  taskId: string;
  commandType: string;
  checkedProposalId: string;
  checkedProposalHash: string;
  idempotencyKey: string;
  confirmationRequired: boolean;
  confirmationId?: string;
  payloadSchema: { schemaName: string; schemaVersion: number };
  payload: JsonValue;
  status: CommandStatusV1;
  failureCategory?: string;
  registeredAt: string;
  updatedAt: string;
}

interface CommandRow {
  command_id: string;
  household_id: string;
  task_id: string;
  command_type: string;
  checked_proposal_id: string;
  checked_proposal_hash: string;
  idempotency_key: string;
  confirmation_required: boolean;
  confirmation_public_id: string | null;
  payload_schema_name: string;
  payload_schema_version: number;
  payload: JsonValue;
  status: CommandStatusV1;
  failure_code: string | null;
  registered_at: string;
  updated_at: string;
}

export class PostgresMutationCommandRepository {
  constructor(private readonly pool: Pool) {}

  async recordConfirmation(candidate: ExternalConfirmationV1): Promise<void> {
    const input = ExternalConfirmationSchemaV1.parse(candidate);
    try {
      const result = await this.pool.query(
        `INSERT INTO operations.external_confirmations
         (confirmation_id, household_id, task_id, checked_proposal_id,
          checked_proposal_hash, principal_id, channel, channel_reference, confirmed_at)
         SELECT $1, household.id, $2, $3, $4, $5, $6, $7, $8
         FROM operations.households household WHERE household.household_id = $9`,
        [input.confirmationId, input.taskId, input.checkedProposalId,
          input.checkedProposalHash, input.principalId, input.channel,
          input.channelReference, input.confirmedAt, input.householdId],
      );
      if (result.rowCount !== 1) throw new PlusOneError({
        category: 'validation_rejected',
        code: 'confirmation_household_not_found',
        message: 'Confirmation household was not found',
        retry: 'never',
        receiptLookupRequired: false,
        details: { householdId: input.householdId },
      });
    } catch (error) {
      throw normalizeDatabaseError(error, { operation: 'record-confirmation' });
    }
  }

  async register(candidate: CheckedCommandV1, confirmationRequired = false): Promise<MutationCommandRecord> {
    const input = CheckedCommandSchemaV1.parse(candidate);
    const preexisting = await this.findByIdempotency(input.householdId, input.idempotencyKey);
    if (preexisting !== undefined) return this.validateReplay(preexisting, input, confirmationRequired);

    try {
      const inserted = await this.pool.query<CommandRow>(
        `INSERT INTO operations.mutation_commands
         (command_id, household_id, task_id, command_type, checked_proposal_id,
          checked_proposal_hash, idempotency_key, confirmation_required, confirmation_id,
          payload_schema_name, payload_schema_version, payload)
         SELECT $1, household.id, $2, $3, $4, $5, $6, $7, confirmation.id, $8, $9, $10
         FROM operations.households household
         LEFT JOIN operations.external_confirmations confirmation
           ON confirmation.household_id = household.id AND confirmation.confirmation_id = $11
         WHERE household.household_id = $12
         RETURNING command_id, $12 AS household_id, task_id, command_type,
          checked_proposal_id, checked_proposal_hash, idempotency_key, confirmation_required,
          $11 AS confirmation_public_id, payload_schema_name, payload_schema_version,
          payload, status, failure_code, registered_at::text, updated_at::text`,
        [input.commandId, input.taskId, input.commandType, input.checkedProposalId,
          input.checkedProposalHash, input.idempotencyKey, confirmationRequired,
          input.payloadSchema.schemaName, input.payloadSchema.schemaVersion, input.payload,
          input.confirmationId ?? null, input.householdId],
      );
      if (inserted.rows[0] === undefined) throw new PlusOneError({
        category: 'validation_rejected',
        code: 'mutation_command_household_not_found',
        message: 'Mutation command household was not found',
        retry: 'never',
        receiptLookupRequired: false,
        details: { householdId: input.householdId },
      });
      return this.mapCommand(inserted.rows[0]);
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === '23505'
        && ['mutation_commands_public_unique', 'mutation_commands_idempotency_unique']
          .includes(failure.constraint ?? '')) {
        const replay = await this.findByIdempotency(input.householdId, input.idempotencyKey);
        if (replay !== undefined) return this.validateReplay(replay, input, confirmationRequired);
      }
      throw this.normalizeRegistrationError(error);
    }
  }

  async markExecutionPending(householdId: string, commandId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE operations.mutation_commands command
       SET status = 'execution_pending', execution_started_at = clock_timestamp()
       FROM operations.households household
       WHERE household.id = command.household_id AND household.household_id = $1
         AND command.command_id = $2 AND command.status = 'registered'`,
      [householdId, commandId],
    );
    if (result.rowCount !== 1) throw this.stateConflict(commandId, 'registered');
  }

  async markExecutionFailed(householdId: string, commandId: string, failureCode: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE operations.mutation_commands command
       SET status = 'execution_failed', failure_code = $1
       FROM operations.households household
       WHERE household.id = command.household_id AND household.household_id = $2
         AND command.command_id = $3 AND command.status = 'execution_pending'`,
      [failureCode, householdId, commandId],
    );
    if (result.rowCount !== 1) throw this.stateConflict(commandId, 'execution_pending');
  }

  async recordReadback(householdId: string, candidate: ReadbackResultV1): Promise<void> {
    const input = ReadbackResultSchemaV1.parse(candidate);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO operations.mutation_readbacks
         (readback_id, household_id, command_id, receipt_id, ok, checks,
          mismatches, observed_state_hash)
         SELECT $1, command.household_id, command.id, receipt.id, $2, $3, $4, $5
         FROM operations.mutation_commands command
         JOIN operations.households household ON household.id = command.household_id
         JOIN operations.mutation_receipts receipt
           ON receipt.household_id = command.household_id AND receipt.command_id = command.id
         WHERE household.household_id = $6 AND command.command_id = $7
           AND receipt.receipt_id = $8 AND command.status = 'committed'`,
        [input.readbackId, input.ok, JSON.stringify(input.checks), input.mismatches,
          input.observedStateHash, householdId, input.commandId, input.receiptId],
      );
      if (inserted.rowCount !== 1) throw this.stateConflict(input.commandId, 'committed');
      const updated = await client.query(
        `UPDATE operations.mutation_commands
         SET status = $1, readback_finished_at = clock_timestamp(), failure_code = $2
         WHERE household_id = (SELECT id FROM operations.households WHERE household_id = $3)
           AND command_id = $4 AND status = 'committed'`,
        [input.ok ? 'readback_verified' : 'readback_failed',
          input.ok ? null : 'readback_mismatch', householdId, input.commandId],
      );
      if (updated.rowCount !== 1) throw this.stateConflict(input.commandId, 'committed');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error instanceof PlusOneError
        ? error
        : normalizeDatabaseError(error, { operation: 'record-readback' });
    } finally {
      client.release();
    }
  }

  async findByIdempotency(householdId: string, idempotencyKey: string) {
    return this.findOne(householdId, 'command.idempotency_key = $2', idempotencyKey);
  }

  async findByCommandId(householdId: string, commandId: string) {
    return this.findOne(householdId, 'command.command_id = $2', commandId);
  }

  async findReceiptByCommand(
    householdId: string,
    commandId: string,
  ): Promise<MutationReceiptV1 | undefined> {
    const result = await this.pool.query<{ receipt: MutationReceiptV1 }>(
      `SELECT jsonb_build_object(
        'schemaName','mutation-receipt','schemaVersion',1,
        'receiptId',receipt.receipt_id,'commandId',command.command_id,
        'householdId',household.household_id,'taskId',command.task_id,
        'checkedProposalId',command.checked_proposal_id,
        'checkedProposalHash',command.checked_proposal_hash,
        'commandType',command.command_type,'idempotencyKey',command.idempotency_key,
        'committedRecords',receipt.committed_records,'expectedState',receipt.expected_state,
        'expectedStateHash',receipt.expected_state_hash,
        'committedAt',to_char(receipt.committed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) AS receipt
      FROM operations.mutation_receipts receipt
      JOIN operations.mutation_commands command
        ON command.household_id = receipt.household_id AND command.id = receipt.command_id
      JOIN operations.households household ON household.id = command.household_id
      WHERE household.household_id = $1 AND command.command_id = $2`,
      [householdId, commandId],
    );
    return result.rows[0] === undefined ? undefined
      : MutationReceiptSchemaV1.parse(result.rows[0].receipt);
  }

  async findReadbackByCommand(
    householdId: string,
    commandId: string,
  ): Promise<ReadbackResultV1 | undefined> {
    const result = await this.pool.query<{ readback: ReadbackResultV1 }>(
      `SELECT jsonb_build_object(
        'schemaName','mutation-readback','schemaVersion',1,
        'readbackId',readback.readback_id,'commandId',command.command_id,
        'receiptId',receipt.receipt_id,'ok',readback.ok,'checks',readback.checks,
        'mismatches',to_jsonb(readback.mismatches),
        'observedStateHash',readback.observed_state_hash
      ) AS readback
      FROM operations.mutation_readbacks readback
      JOIN operations.mutation_commands command
        ON command.household_id = readback.household_id AND command.id = readback.command_id
      JOIN operations.mutation_receipts receipt
        ON receipt.household_id = readback.household_id AND receipt.id = readback.receipt_id
      JOIN operations.households household ON household.id = command.household_id
      WHERE household.household_id = $1 AND command.command_id = $2`,
      [householdId, commandId],
    );
    return result.rows[0] === undefined ? undefined
      : ReadbackResultSchemaV1.parse(result.rows[0].readback);
  }

  private async findOne(householdId: string, predicate: string, value: string) {
    const result = await this.pool.query<CommandRow>(
      `SELECT command.command_id, household.household_id, command.task_id,
        command.command_type, command.checked_proposal_id, command.checked_proposal_hash,
        command.idempotency_key, command.confirmation_required,
        confirmation.confirmation_id AS confirmation_public_id,
        command.payload_schema_name, command.payload_schema_version, command.payload,
        command.status, command.failure_code,
        command.registered_at::text, command.updated_at::text
       FROM operations.mutation_commands command
       JOIN operations.households household ON household.id = command.household_id
       LEFT JOIN operations.external_confirmations confirmation
         ON confirmation.household_id = command.household_id
        AND confirmation.id = command.confirmation_id
       WHERE household.household_id = $1 AND ${predicate}`,
      [householdId, value],
    );
    return result.rows[0] === undefined ? undefined : this.mapCommand(result.rows[0]);
  }

  private mapCommand(row: CommandRow): MutationCommandRecord {
    return {
      commandId: row.command_id,
      householdId: row.household_id,
      taskId: row.task_id,
      commandType: row.command_type,
      checkedProposalId: row.checked_proposal_id,
      checkedProposalHash: row.checked_proposal_hash,
      idempotencyKey: row.idempotency_key,
      confirmationRequired: row.confirmation_required,
      ...(row.confirmation_public_id === null ? {} : { confirmationId: row.confirmation_public_id }),
      payloadSchema: { schemaName: row.payload_schema_name, schemaVersion: row.payload_schema_version },
      payload: row.payload,
      status: row.status,
      ...(row.failure_code === null ? {} : { failureCategory: row.failure_code }),
      registeredAt: row.registered_at,
      updatedAt: row.updated_at,
    };
  }

  private validateReplay(
    record: MutationCommandRecord,
    input: CheckedCommandV1,
    confirmationRequired: boolean,
  ): MutationCommandRecord {
    if (this.sameEnvelope(record, input, confirmationRequired)) return record;
    throw new PlusOneError({
      category: 'duplicate_replay',
      code: 'idempotency_key_reused',
      message: 'Idempotency key is already bound to a different command envelope',
      retry: 'never',
      receiptLookupRequired: true,
      details: { idempotencyKey: input.idempotencyKey },
    });
  }

  private sameEnvelope(
    record: MutationCommandRecord,
    input: CheckedCommandV1,
    confirmationRequired: boolean,
  ): boolean {
    return record.commandId === input.commandId
      && record.taskId === input.taskId
      && record.commandType === input.commandType
      && record.checkedProposalId === input.checkedProposalId
      && record.checkedProposalHash === input.checkedProposalHash
      && record.confirmationRequired === confirmationRequired
      && record.confirmationId === input.confirmationId
      && record.payloadSchema.schemaName === input.payloadSchema.schemaName
      && record.payloadSchema.schemaVersion === input.payloadSchema.schemaVersion
      && this.stableJson(record.payload) === this.stableJson(input.payload);
  }

  private stableJson(value: JsonValue): string {
    if (Array.isArray(value)) return '[' + value.map((entry) => this.stableJson(entry)).join(',') + ']';
    if (value !== null && typeof value === 'object') {
      return '{' + Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => JSON.stringify(key) + ':' + this.stableJson(entry))
        .join(',') + '}';
    }
    return JSON.stringify(value);
  }

  private normalizeRegistrationError(error: unknown): PlusOneError {
    if (error instanceof PlusOneError) return error;
    const failure = error as { code?: string; constraint?: string };
    if (failure.code === '23505' && failure.constraint === 'mutation_commands_checked_proposal_once') {
      return new PlusOneError({
        category: 'duplicate_replay',
        code: 'checked_proposal_already_commanded',
        message: 'The exact checked proposal is already bound to a mutation command',
        retry: 'never',
        receiptLookupRequired: true,
        details: {},
        cause: error,
      });
    }
    return normalizeDatabaseError(error, { operation: 'register-mutation-command' });
  }

  private stateConflict(commandId: string, expected: string): PlusOneError {
    return new PlusOneError({
      category: 'serialization_conflict',
      code: 'mutation_command_state_conflict',
      message: 'Mutation command state changed before the operation completed',
      retry: 'after_state_resolution',
      receiptLookupRequired: true,
      details: { commandId, expected },
    });
  }
}
