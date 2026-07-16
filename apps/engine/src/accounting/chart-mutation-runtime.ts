import {
  ExternalConfirmationSchemaV1,
  InboundChannelMessageSchemaV1,
  PlusOneError,
  TeamResultEnvelopeSchemaV2,
  type InboundChannelMessageV1,
  type TeamResultEnvelopeV2,
} from '@plus-one/contracts';
import { AccountingMutationService } from '@plus-one/accounting';
import { PostgresMutationCommandRepository } from '@plus-one/database';
import { CheckedMutationWorkCellCoordinator } from '@plus-one/mutations';
import {
  TeamResultAssembler,
  VerificationRuntime,
} from '@plus-one/runtime';

export interface ChartMutationRuntime {
  prepare(input: {
    workCellInput: Parameters<AccountingMutationService['prepareChart']>[0]['workCellInput'];
    resultMetadata: Omit<Parameters<TeamResultAssembler['assemble']>[0], 'results'>;
  }): Promise<TeamResultEnvelopeV2>;
  resume(input: {
    message: InboundChannelMessageV1;
    pending: TeamResultEnvelopeV2;
  }): Promise<TeamResultEnvelopeV2>;
  cancel(input: { pending: TeamResultEnvelopeV2 }): Promise<void>;
}

export class DefaultChartMutationRuntime implements ChartMutationRuntime {
  constructor(private readonly dependencies: {
    service: Pick<AccountingMutationService, 'prepareChart'>;
    assembler: TeamResultAssembler;
    commands: Pick<PostgresMutationCommandRepository, 'recordConfirmation'>;
    coordinator: Pick<CheckedMutationWorkCellCoordinator, 'resume'>;
    verification: Pick<VerificationRuntime, 'complete'>;
    nextCommandId(): string;
    nextIdempotencyKey(): string;
    nextConfirmationId(): string;
  }) {}

  async prepare(input: {
    workCellInput: Parameters<AccountingMutationService['prepareChart']>[0]['workCellInput'];
    resultMetadata: Omit<Parameters<TeamResultAssembler['assemble']>[0], 'results'>;
  }): Promise<TeamResultEnvelopeV2> {
    const prepared = await this.dependencies.service.prepareChart({
      workCellInput: input.workCellInput,
      commandId: this.dependencies.nextCommandId(),
      idempotencyKey: this.dependencies.nextIdempotencyKey(),
    });
    return this.dependencies.assembler.assemble({
      ...input.resultMetadata,
      results: [prepared],
    });
  }

  async resume(input: {
    message: InboundChannelMessageV1;
    pending: TeamResultEnvelopeV2;
  }): Promise<TeamResultEnvelopeV2> {
    const message = InboundChannelMessageSchemaV1.parse(input.message);
    const result = TeamResultEnvelopeSchemaV2.parse(input.pending);
    if (result.effect.state !== 'awaiting_confirmation'
      || result.householdId !== message.householdId) {
      throw new PlusOneError({
        category: 'validation_rejected',
        code: 'pending_chart_mutation_mismatch',
        message: 'Pending chart mutation does not match the inbound household',
        retry: 'never',
        receiptLookupRequired: false,
        details: {},
      });
    }
    const confirmation = ExternalConfirmationSchemaV1.parse({
      schemaName: 'external-confirmation',
      schemaVersion: 1,
      confirmationId: this.dependencies.nextConfirmationId(),
      householdId: message.householdId,
      taskId: result.effect.proposal.taskId,
      checkedProposalId: result.effect.proposal.artifactId,
      checkedProposalHash: result.effect.proposal.artifactHash,
      principalId: message.speaker.principalRef,
      channel: message.channel,
      channelReference: message.externalMessageId,
      confirmedAt: message.receivedAt,
    });
    await this.dependencies.commands.recordConfirmation(confirmation);
    try {
      const executed = await this.dependencies.coordinator.resume({
        ...result.effect.command,
        confirmationId: confirmation.confirmationId,
      });
      return TeamResultEnvelopeSchemaV2.parse({
        ...result,
        status: 'verified',
        completionReason: 'The checked chart change was committed and read back successfully.',
        effect: {
          state: 'persisted',
          proposal: result.effect.proposal,
          receipt: executed.receipt,
          readback: executed.readback,
        },
      });
    } catch (error) {
      if (!(error instanceof PlusOneError)
        || !error.receiptLookupRequired
        || !['ambiguous_mutation_commit', 'mutation_readback_failed'].includes(error.code)) {
        throw error;
      }
      return TeamResultEnvelopeSchemaV2.parse({
        ...result,
        status: 'failed',
        completionReason: 'The mutation outcome requires deterministic reconciliation.',
        effect: {
          state: 'unresolved',
          proposal: result.effect.proposal,
          commandId: result.effect.command.commandId,
          reason: error.code === 'mutation_readback_failed' ? 'readback_failed' : 'commit_ambiguous',
        },
      });
    }
  }

  async cancel({ pending }: { pending: TeamResultEnvelopeV2 }): Promise<void> {
    const result = TeamResultEnvelopeSchemaV2.parse(pending);
    if (result.effect.state !== 'awaiting_confirmation') {
      throw new PlusOneError({
        category: 'validation_rejected',
        code: 'pending_chart_mutation_required',
        message: 'Only a pending chart mutation may be cancelled',
        retry: 'never',
        receiptLookupRequired: false,
        details: {},
      });
    }
    await this.dependencies.verification.complete({
      householdId: result.householdId,
      taskId: result.effect.proposal.taskId,
      status: 'partial',
    });
  }
}
