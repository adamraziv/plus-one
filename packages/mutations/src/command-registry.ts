import {
  PlusOneError,
  type CheckedCommandV1,
  type JsonValue,
  type MutationReceiptV1,
  type ReadbackCheckKindV1,
} from '@plus-one/contracts';
import type { PoolClient } from 'pg';
import type { z } from 'zod';

export interface MutationExecutionContext {
  householdId: string;
  taskId: string;
  commandId: string;
  checkedProposalId: string;
  checkedProposalHash: string;
  idempotencyKey: string;
}

export interface MutationExecutionOutput {
  committedRecords: Array<{ recordType: string; recordId: string }>;
  expectedState: JsonValue;
}

export interface DomainReadbackOutput {
  checks: Array<{
    kind: Exclude<ReadbackCheckKindV1, 'idempotency_receipt'>;
    status: 'passed' | 'failed' | 'not_applicable';
    detailCode?: string;
  }>;
  mismatches: string[];
  observedState: JsonValue;
}

export interface MutationCommandHandler<Input = unknown> {
  commandType: string;
  domainRole: 'accounting' | 'planning';
  inputSchema: z.ZodType<Input>;
  inputSchemaIdentity: { schemaName: string; schemaVersion: number };
  confirmation: 'required' | 'optional' | 'forbidden';
  requiredReadbackChecks: readonly ReadbackCheckKindV1[];
  execute(
    client: PoolClient,
    input: Input,
    context: MutationExecutionContext,
  ): Promise<MutationExecutionOutput>;
  readback(client: PoolClient, input: Input, receipt: MutationReceiptV1): Promise<DomainReadbackOutput>;
}

export interface PreparedCommand<Input = unknown> {
  handler: MutationCommandHandler<Input>;
  input: Input;
}

export class CommandRegistry {
  private readonly handlers = new Map<string, MutationCommandHandler>();

  constructor(handlers: readonly MutationCommandHandler[]) {
    for (const handler of handlers) {
      if (this.handlers.has(handler.commandType)) {
        throw new TypeError('Duplicate command type: ' + handler.commandType);
      }
      if (!handler.requiredReadbackChecks.includes('idempotency_receipt')) {
        throw new TypeError('Mutation handlers must require idempotency_receipt read-back');
      }
      this.handlers.set(handler.commandType, handler);
    }
  }

  prepare(command: {
    commandType: CheckedCommandV1['commandType'];
    payloadSchema: CheckedCommandV1['payloadSchema'];
    payload: CheckedCommandV1['payload'];
    confirmationId?: string;
  }): PreparedCommand {
    const handler = this.handlers.get(command.commandType);
    if (handler === undefined) throw new PlusOneError({
      category: 'policy_rejected',
      code: 'mutation_command_not_allowlisted',
      message: 'Mutation command type is not allowlisted',
      retry: 'never',
      receiptLookupRequired: false,
      details: { commandType: command.commandType },
    });
    if (handler.inputSchemaIdentity.schemaName !== command.payloadSchema.schemaName
      || handler.inputSchemaIdentity.schemaVersion !== command.payloadSchema.schemaVersion) {
      throw new PlusOneError({
        category: 'validation_rejected',
        code: 'mutation_command_schema_identity_mismatch',
        message: 'Command payload schema identity does not match its registered handler',
        retry: 'never',
        receiptLookupRequired: false,
        details: { commandType: command.commandType },
      });
    }
    if (handler.confirmation === 'required' && command.confirmationId === undefined) {
      throw new PlusOneError({
        category: 'confirmation_required',
        code: 'external_confirmation_required',
        message: 'This mutation command requires an external confirmation reference',
        retry: 'after_state_resolution',
        receiptLookupRequired: false,
        details: { commandType: command.commandType },
      });
    }
    if (handler.confirmation === 'forbidden' && command.confirmationId !== undefined) {
      throw new PlusOneError({
        category: 'validation_rejected',
        code: 'unexpected_confirmation_reference',
        message: 'This mutation command does not accept a confirmation reference',
        retry: 'never',
        receiptLookupRequired: false,
        details: { commandType: command.commandType },
      });
    }
    return { handler, input: handler.inputSchema.parse(command.payload) };
  }
}
