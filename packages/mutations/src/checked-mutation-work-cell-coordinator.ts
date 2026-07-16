import {
  CheckedCommandSchemaV1,
  PlusOneError,
  type CheckedCommandV1,
  type JsonValue,
  type MutationReceiptV1,
  type ReadbackResultV1,
} from '@plus-one/contracts';
import {
  canonicalizeJson,
  type CheckedWorkCellResult,
  type TeamExecutor,
  type VerificationLedgerPort,
  type VerificationRuntime,
} from '@plus-one/runtime';
import type { CheckedMutationExecutor } from './checked-mutation-executor.js';

type WorkCellInput = Parameters<TeamExecutor['executeWorkCell']>[0];

export interface CheckedMutationCommandAdapter {
  buildCommand(input: {
    commandId: string;
    idempotencyKey: string;
    confirmationId?: string;
    householdId: string;
    taskId: string;
    checkedProposalId: string;
    checkedProposalHash: string;
    payloadSchema: { schemaName: string; schemaVersion: number };
    payload: JsonValue;
  }): CheckedCommandV1;
}

export interface PreparedMutationWorkCellResult extends CheckedWorkCellResult {
  status: 'verified';
  completionState: 'checked_mutation_pending';
  effectRequirement: Extract<CheckedWorkCellResult['effectRequirement'], { kind: 'checked_mutation' }>;
  command: CheckedCommandV1;
  mutation: { state: 'prepared'; command: CheckedCommandV1 };
}

export interface VerifiedMutationWorkCellResult extends CheckedWorkCellResult {
  status: 'verified';
  completionState: 'terminal';
  effectRequirement: Extract<CheckedWorkCellResult['effectRequirement'], { kind: 'checked_mutation' }>;
  mutation: { state: 'persisted'; receipt: MutationReceiptV1; readback: ReadbackResultV1 };
}

export class CheckedMutationWorkCellCoordinator {
  constructor(private readonly dependencies: {
    teamExecutor: Pick<TeamExecutor, 'executeWorkCell'>;
    mutationExecutor: Pick<CheckedMutationExecutor, 'execute'>;
    runtime: Pick<VerificationRuntime, 'complete'>;
    ledger: Pick<VerificationLedgerPort, 'findTask'>;
  }) {}

  async prepare(input: {
    workCellInput: WorkCellInput;
    commandId: string;
    idempotencyKey: string;
    adapter: CheckedMutationCommandAdapter;
  }): Promise<PreparedMutationWorkCellResult> {
    const checked = await this.dependencies.teamExecutor.executeWorkCell(input.workCellInput);
    const makerArtifact = checked.makerArtifacts.at(-1);
    const effectRequirement = checked.effectRequirement;
    const acceptedMaker = checked.acceptedMaker;
    if (checked.status !== 'verified'
      || checked.completionState !== 'checked_mutation_pending'
      || effectRequirement.kind !== 'checked_mutation'
      || acceptedMaker === undefined
      || makerArtifact === undefined
      || canonicalizeJson(makerArtifact.payload) !== canonicalizeJson(acceptedMaker)) {
      throw new PlusOneError({
        category: 'constraint_violation',
        code: 'checked_mutation_result_invalid',
        message: 'Mutation preparation requires one exact deferred accepted maker artifact',
        retry: 'never',
        receiptLookupRequired: false,
        details: { taskId: checked.taskId, completionState: checked.completionState },
      });
    }
    const common: Parameters<CheckedMutationCommandAdapter['buildCommand']>[0] = {
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      householdId: checked.householdId,
      taskId: checked.taskId,
      checkedProposalId: makerArtifact.artifactId,
      checkedProposalHash: makerArtifact.artifactHash,
      payloadSchema: effectRequirement.proposalSchema,
      payload: acceptedMaker.output,
    };
    const command = CheckedCommandSchemaV1.parse(input.adapter.buildCommand(common));
    assertUnchangedCheckedCommand(common, command, checked.workCellId);
    return {
      ...checked,
      status: 'verified',
      completionState: 'checked_mutation_pending',
      effectRequirement,
      acceptedMaker,
      command,
      mutation: { state: 'prepared', command },
    };
  }

  async executePrepared(input: {
    prepared: PreparedMutationWorkCellResult;
    confirmationId?: string;
  }): Promise<VerifiedMutationWorkCellResult> {
    if (input.prepared.effectRequirement.confirmation === 'required'
      && input.confirmationId === undefined) {
      throw new PlusOneError({
        category: 'confirmation_required',
        code: 'external_confirmation_required',
        message: 'This checked mutation requires an exact external confirmation',
        retry: 'after_state_resolution',
        receiptLookupRequired: false,
        details: { workCellId: input.prepared.workCellId },
      });
    }
    const command = CheckedCommandSchemaV1.parse({
      ...input.prepared.command,
      ...(input.confirmationId === undefined ? {} : { confirmationId: input.confirmationId }),
    });
    const executed = await this.dependencies.mutationExecutor.execute(command);
    await this.finalize(command);
    return {
      ...input.prepared,
      completionState: 'terminal',
      mutation: { state: 'persisted', receipt: executed.receipt, readback: executed.readback },
    };
  }

  async execute(input: {
    workCellInput: WorkCellInput;
    commandId: string;
    idempotencyKey: string;
    confirmationId?: string;
    adapter: CheckedMutationCommandAdapter;
  }): Promise<VerifiedMutationWorkCellResult> {
    const prepared = await this.prepare({
      workCellInput: input.workCellInput,
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      adapter: input.adapter,
    });
    return this.executePrepared({
      prepared,
      ...(input.confirmationId === undefined ? {} : { confirmationId: input.confirmationId }),
    });
  }

  async resume(candidate: CheckedCommandV1): Promise<{
    receipt: MutationReceiptV1;
    readback: ReadbackResultV1;
  }> {
    const command = CheckedCommandSchemaV1.parse(candidate);
    const executed = await this.dependencies.mutationExecutor.execute(command);
    await this.finalize(command);
    return { receipt: executed.receipt, readback: executed.readback };
  }

  private async finalize(command: CheckedCommandV1): Promise<void> {
    const task = await this.dependencies.ledger.findTask(command.householdId, command.taskId);
    if (task?.status === 'verified') return;
    if (task?.status !== 'readback_verified') {
      throw new PlusOneError({
        category: 'constraint_violation',
        code: 'mutation_readback_not_verified',
        message: 'Mutation work-cell completion requires durable read-back verification',
        retry: 'after_state_resolution',
        receiptLookupRequired: true,
        details: { taskId: command.taskId, status: task?.status ?? 'missing' },
      });
    }
    await this.dependencies.runtime.complete({
      householdId: command.householdId,
      taskId: command.taskId,
      status: 'verified',
    });
  }
}

function assertUnchangedCheckedCommand(
  common: Parameters<CheckedMutationCommandAdapter['buildCommand']>[0],
  command: CheckedCommandV1,
  workCellId: string,
): void {
  if (command.commandId !== common.commandId
    || command.idempotencyKey !== common.idempotencyKey
    || command.householdId !== common.householdId
    || command.taskId !== common.taskId
    || command.checkedProposalId !== common.checkedProposalId
    || command.checkedProposalHash !== common.checkedProposalHash
    || canonicalizeJson(command.payloadSchema) !== canonicalizeJson(common.payloadSchema)
    || canonicalizeJson(command.payload) !== canonicalizeJson(common.payload)
    || command.confirmationId !== common.confirmationId) {
    throw new PlusOneError({
      category: 'validation_rejected',
      code: 'mutation_adapter_changed_checked_identity',
      message: 'A mutation adapter may select a command type but cannot change checked identity or payload',
      retry: 'never',
      receiptLookupRequired: false,
      details: { taskId: common.taskId, workCellId },
    });
  }
}
