import {
  MutationReceiptSchemaV1,
  PlusOneError,
  type MutationReceiptV1,
} from '@plus-one/contracts';
import { normalizeDatabaseError, type PostgresDomainCommandBridge } from '@plus-one/database';
import { hashArtifact } from '@plus-one/runtime';
import type { PoolClient } from 'pg';
import type { MutationCommandHandler, MutationExecutionContext } from './command-registry.js';

export interface MutationClientRouter {
  connect(role: 'accounting' | 'planning'): Promise<PoolClient>;
}

export interface SerializableMutationPolicy {
  maxAttempts: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  idleTransactionTimeoutMs: number;
  overallTimeoutMs: number;
  retryDelayMs: number;
}

const defaultPolicy: SerializableMutationPolicy = {
  maxAttempts: 3,
  statementTimeoutMs: 5_000,
  lockTimeoutMs: 1_000,
  idleTransactionTimeoutMs: 5_000,
  overallTimeoutMs: 15_000,
  retryDelayMs: 25,
};

export interface RunnableCommand extends MutationExecutionContext {
  commandType: string;
}

export class SerializableMutationRunner {
  private readonly policy: SerializableMutationPolicy;

  constructor(private readonly dependencies: {
    clients: MutationClientRouter;
    bridge: PostgresDomainCommandBridge;
    findReceipt(householdId: string, commandId: string): Promise<MutationReceiptV1 | undefined>;
    sleep(milliseconds: number): Promise<void>;
    now(): number;
    policy?: Partial<SerializableMutationPolicy>;
  }) {
    this.policy = { ...defaultPolicy, ...dependencies.policy };
    if (this.policy.maxAttempts < 1 || this.policy.maxAttempts > 5) {
      throw new RangeError('Serializable mutation attempts must be between 1 and 5');
    }
  }

  async run<Input>(input: {
    command: RunnableCommand;
    handler: MutationCommandHandler<Input>;
    input: Input;
    receiptId: string;
  }): Promise<MutationReceiptV1> {
    const startedAt = this.dependencies.now();
    for (let attempt = 1; attempt <= this.policy.maxAttempts; attempt += 1) {
      if (this.dependencies.now() - startedAt >= this.policy.overallTimeoutMs) {
        throw this.retryExhausted(input.command.commandId, 'mutation_overall_timeout');
      }
      const client = await this.dependencies.clients.connect(input.handler.domainRole);
      let began = false;
      let commitAttempted = false;
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        began = true;
        await this.applyTimeouts(client);
        const claim = await this.dependencies.bridge.claim(
          client,
          input.command.householdId,
          input.command.commandId,
        );
        if (claim.status !== 'execution_pending') {
          await client.query('ROLLBACK');
          began = false;
          return await this.requireExistingReceipt(input.command);
        }
        const output = await input.handler.execute(client, input.input, input.command);
        const expectedStateHash = hashArtifact(output.expectedState);
        const committed = await this.dependencies.bridge.commit(client, {
          householdId: input.command.householdId,
          commandId: input.command.commandId,
          receiptId: input.receiptId,
          committedRecords: output.committedRecords,
          expectedState: output.expectedState,
          expectedStateHash,
        });
        commitAttempted = true;
        await client.query('COMMIT');
        began = false;
        return MutationReceiptSchemaV1.parse({
          schemaName: 'mutation-receipt',
          schemaVersion: 1,
          receiptId: committed.receiptId,
          commandId: input.command.commandId,
          householdId: input.command.householdId,
          taskId: input.command.taskId,
          checkedProposalId: input.command.checkedProposalId,
          checkedProposalHash: input.command.checkedProposalHash,
          commandType: input.command.commandType,
          idempotencyKey: input.command.idempotencyKey,
          committedRecords: output.committedRecords,
          expectedState: output.expectedState,
          expectedStateHash,
          committedAt: committed.committedAt,
        });
      } catch (error) {
        if (began && !commitAttempted) await client.query('ROLLBACK').catch(() => undefined);
        if (commitAttempted || this.isConnectionFailure(error)) {
          const receipt = await this.dependencies.findReceipt(
            input.command.householdId,
            input.command.commandId,
          );
          if (receipt !== undefined) return receipt;
          if (commitAttempted) throw new PlusOneError({
            category: 'storage_unavailable',
            code: 'ambiguous_mutation_commit',
            message: 'Mutation commit result is ambiguous and requires command-state resolution',
            retry: 'after_state_resolution',
            receiptLookupRequired: true,
            details: { commandId: input.command.commandId },
            cause: error,
          });
        }
        if (this.isSerializationFailure(error) && attempt < this.policy.maxAttempts) {
          await this.dependencies.sleep(this.policy.retryDelayMs * attempt);
          continue;
        }
        if (this.isSerializationFailure(error)) {
          throw this.retryExhausted(input.command.commandId, 'serialization_retry_exhausted');
        }
        throw error instanceof PlusOneError
          ? error
          : normalizeDatabaseError(error, { operation: 'serializable-mutation' });
      } finally {
        client.release();
      }
    }
    throw this.retryExhausted(input.command.commandId, 'serialization_retry_exhausted');
  }

  private async applyTimeouts(client: PoolClient): Promise<void> {
    await client.query(
      `SELECT set_config('statement_timeout', $1, true),
        set_config('lock_timeout', $2, true),
        set_config('idle_in_transaction_session_timeout', $3, true)`,
      [
        this.policy.statementTimeoutMs + 'ms',
        this.policy.lockTimeoutMs + 'ms',
        this.policy.idleTransactionTimeoutMs + 'ms',
      ],
    );
  }

  private async requireExistingReceipt(command: RunnableCommand): Promise<MutationReceiptV1> {
    const receipt = await this.dependencies.findReceipt(command.householdId, command.commandId);
    if (receipt === undefined) throw new PlusOneError({
      category: 'constraint_violation',
      code: 'committed_command_receipt_missing',
      message: 'Committed mutation command has no durable receipt',
      retry: 'never',
      receiptLookupRequired: true,
      details: { commandId: command.commandId },
    });
    return receipt;
  }

  private isSerializationFailure(error: unknown): boolean {
    return (error as { code?: string }).code === '40001';
  }

  private isConnectionFailure(error: unknown): boolean {
    return (error as { code?: string }).code?.startsWith('08') ?? false;
  }

  private retryExhausted(commandId: string, code: string): PlusOneError {
    return new PlusOneError({
      category: 'serialization_conflict',
      code,
      message: 'Mutation transaction retry policy was exhausted',
      retry: 'after_state_resolution',
      receiptLookupRequired: true,
      details: { commandId },
    });
  }
}
