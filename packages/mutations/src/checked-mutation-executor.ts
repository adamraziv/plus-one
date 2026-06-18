import {
  CheckedCommandSchemaV1,
  MakerArtifactSchemaV1,
  PlusOneError,
  ReadbackResultSchemaV1,
  type CheckedCommandV1,
  type MutationReceiptV1,
  type ReadbackCheckKindV1,
  type ReadbackResultV1,
} from '@plus-one/contracts';
import type { PostgresMutationCommandRepository } from '@plus-one/database';
import {
  canonicalizeJson,
  hashArtifact,
  type ArtifactStore,
  type VerificationLedgerPort,
} from '@plus-one/runtime';
import type { PoolClient } from 'pg';
import type { CommandStateResolver } from './command-state-resolver.js';
import type { CommandRegistry, MutationCommandHandler } from './command-registry.js';
import type { SerializableMutationRunner } from './serializable-runner.js';

interface ReadClientRouter {
  connect(role: 'accounting' | 'planning'): Promise<PoolClient>;
}

export class CheckedMutationExecutor {
  constructor(private readonly dependencies: {
    artifacts: ArtifactStore;
    ledger: Pick<VerificationLedgerPort, 'findLatestVerdict' | 'transition'>;
    commands: PostgresMutationCommandRepository;
    resolver: CommandStateResolver;
    registry: CommandRegistry;
    runner: SerializableMutationRunner;
    readClients: ReadClientRouter;
    newReadbackId(): string;
  }) {}

  async execute(candidate: CheckedCommandV1): Promise<{
    status: 'readback_verified';
    receipt: MutationReceiptV1;
    readback: ReadbackResultV1;
  }> {
    const command = CheckedCommandSchemaV1.parse(candidate);
    const artifact = await this.dependencies.artifacts.getVerified(command.checkedProposalId);
    this.assertExactArtifact(command, artifact);
    const verdict = await this.dependencies.ledger.findLatestVerdict(
      command.householdId,
      command.taskId,
    );
    if (verdict?.verdict !== 'accepted'
      || verdict.coveredArtifactId !== command.checkedProposalId
      || verdict.coveredArtifactHash !== command.checkedProposalHash) {
      throw new PlusOneError({
        category: 'checker_rejected',
        code: 'exact_checker_acceptance_required',
        message: 'Mutation execution requires an accepting verdict for the exact maker artifact',
        retry: 'never',
        receiptLookupRequired: false,
        details: { taskId: command.taskId },
      });
    }

    const prepared = this.dependencies.registry.prepare({
      commandType: command.commandType,
      payloadSchema: command.payloadSchema,
      payload: command.payload,
      ...(command.confirmationId === undefined ? {} : { confirmationId: command.confirmationId }),
    });
    const registered = await this.dependencies.commands.register(
      command,
      prepared.handler.confirmation === 'required',
    );
    let state = await this.dependencies.resolver.reconcile(
      registered.householdId,
      registered.commandId,
    );
    if (state.status === 'readback_verified') return this.requireVerifiedReplay(command);
    if (state.status === 'execution_failed' || state.status === 'readback_failed') {
      throw new PlusOneError({
        category: state.status === 'readback_failed' ? 'readback_mismatch' : 'runtime_failure',
        code: 'mutation_command_terminal_failure',
        message: 'Mutation command is already in a terminal failed state',
        retry: 'never',
        receiptLookupRequired: true,
        details: { commandId: command.commandId, status: registered.status },
      });
    }

    let receipt = await this.dependencies.commands.findReceiptByCommand(
      command.householdId,
      command.commandId,
    );
    if (state.status === 'execution_pending') {
      try {
        receipt = await this.dependencies.runner.run({
          command,
          handler: prepared.handler,
          input: prepared.input,
          receiptId: command.commandId.replace(/^command_/, 'receipt_'),
        });
      } catch (error) {
        const resolved = await this.dependencies.resolver
          .reconcile(command.householdId, command.commandId)
          .catch(() => undefined);
        if (resolved?.status === 'committed' || resolved?.status === 'readback_verified') {
          state = resolved;
        } else {
          if (error instanceof PlusOneError && error.receiptLookupRequired) throw error;
          await this.dependencies.commands.markExecutionFailed(
            command.householdId,
            command.commandId,
            this.failureCategory(error),
          );
          await this.dependencies.resolver.reconcile(command.householdId, command.commandId);
          throw error;
        }
      }
      if (state.status === 'execution_pending') {
        state = await this.dependencies.resolver.reconcile(
          command.householdId,
          command.commandId,
        );
      }
    }
    if (state.status === 'readback_verified') return this.requireVerifiedReplay(command);
    if (state.status === 'execution_failed' || state.status === 'readback_failed') {
      throw new PlusOneError({
        category: state.status === 'readback_failed' ? 'readback_mismatch' : 'runtime_failure',
        code: 'mutation_command_terminal_failure',
        message: 'Mutation command is already in a terminal failed state',
        retry: 'never',
        receiptLookupRequired: true,
        details: { commandId: command.commandId, status: state.status },
      });
    }
    if (receipt === undefined) {
      receipt = await this.dependencies.commands.findReceiptByCommand(
        command.householdId,
        command.commandId,
      );
    }
    if (state.status !== 'committed' || receipt === undefined) {
      throw new PlusOneError({
        category: 'constraint_violation',
        code: 'committed_mutation_receipt_missing',
        message: 'Committed mutation state or receipt is missing',
        retry: 'never',
        receiptLookupRequired: true,
        details: { commandId: command.commandId },
      });
    }

    let readback: ReadbackResultV1;
    try {
      readback = await this.performReadback(command, prepared.handler, prepared.input, receipt);
    } catch (error) {
      readback = this.failedReadback(command, receipt, prepared.handler.requiredReadbackChecks, error);
    }
    try {
      await this.dependencies.commands.recordReadback(command.householdId, readback);
    } catch (error) {
      const existing = await this.dependencies.commands.findReadbackByCommand(
        command.householdId,
        command.commandId,
      );
      if (existing === undefined) throw error;
      readback = existing;
    }
    state = await this.dependencies.resolver.reconcile(command.householdId, command.commandId);
    if (!readback.ok || state.status === 'readback_failed') {
      throw new PlusOneError({
        category: 'readback_mismatch',
        code: 'mutation_readback_failed',
        message: 'Committed mutation did not pass deterministic read-back verification',
        retry: 'after_state_resolution',
        receiptLookupRequired: true,
        details: { commandId: command.commandId, mismatchCount: readback.mismatches.length },
      });
    }
    return { status: 'readback_verified', receipt, readback };
  }

  private assertExactArtifact(command: CheckedCommandV1, artifact: Awaited<
    ReturnType<ArtifactStore['getVerified']>
  >): void {
    const maker = MakerArtifactSchemaV1.safeParse(artifact.payload);
    if (artifact.artifactId !== command.checkedProposalId
      || artifact.householdId !== command.householdId
      || artifact.taskId !== command.taskId
      || artifact.artifactHash !== command.checkedProposalHash
      || artifact.schema.schemaName !== 'maker-artifact'
      || artifact.schema.schemaVersion !== 1
      || !maker.success
      || maker.data.outputSchema.schemaName !== command.payloadSchema.schemaName
      || maker.data.outputSchema.schemaVersion !== command.payloadSchema.schemaVersion
      || canonicalizeJson(maker.data.output) !== canonicalizeJson(command.payload)) {
      throw new PlusOneError({
        category: 'validation_rejected',
        code: 'checked_proposal_identity_mismatch',
        message: 'Checked command does not match the immutable maker artifact',
        retry: 'never',
        receiptLookupRequired: false,
        details: { commandId: command.commandId, artifactId: command.checkedProposalId },
      });
    }
  }

  private async performReadback<Input>(
    command: CheckedCommandV1,
    handler: MutationCommandHandler<Input>,
    input: Input,
    receipt: MutationReceiptV1,
  ): Promise<ReadbackResultV1> {
    const client = await this.dependencies.readClients.connect(handler.domainRole);
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query(
        `SELECT set_config('statement_timeout','5000ms',true),
          set_config('idle_in_transaction_session_timeout','5000ms',true)`,
      );
      const domain = await handler.readback(client, input, receipt);
      const persistedReceipt = await this.dependencies.commands.findReceiptByCommand(
        command.householdId,
        command.commandId,
      );
      const receiptOk = persistedReceipt?.receiptId === receipt.receiptId
        && persistedReceipt.idempotencyKey === command.idempotencyKey
        && persistedReceipt.checkedProposalId === command.checkedProposalId
        && persistedReceipt.checkedProposalHash === command.checkedProposalHash;
      const checks = [
        ...domain.checks,
        {
          kind: 'idempotency_receipt' as const,
          status: receiptOk ? 'passed' as const : 'failed' as const,
          ...(receiptOk ? {} : { detailCode: 'receipt_identity_mismatch' }),
        },
      ];
      const requiredFailures = this.requiredFailures(handler.requiredReadbackChecks, checks);
      const mismatches = [...domain.mismatches, ...requiredFailures];
      const observedStateHash = hashArtifact({
        domain: domain.observedState,
        receipt: persistedReceipt ?? null,
      });
      await client.query('COMMIT');
      return ReadbackResultSchemaV1.parse({
        schemaName: 'mutation-readback',
        schemaVersion: 1,
        readbackId: this.dependencies.newReadbackId(),
        commandId: command.commandId,
        receiptId: receipt.receiptId,
        ok: mismatches.length === 0,
        checks,
        mismatches,
        observedStateHash,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private requiredFailures(
    required: readonly ReadbackCheckKindV1[],
    checks: Array<{
      kind: ReadbackCheckKindV1;
      status: 'passed' | 'failed' | 'not_applicable';
    }>,
  ): string[] {
    return required.flatMap((kind) => {
      const check = checks.find((candidate) => candidate.kind === kind);
      return check?.status === 'passed' ? [] : ['required_check.' + kind];
    });
  }

  private failedReadback(
    command: CheckedCommandV1,
    receipt: MutationReceiptV1,
    required: readonly ReadbackCheckKindV1[],
    error: unknown,
  ): ReadbackResultV1 {
    const allKinds: readonly ReadbackCheckKindV1[] = [
      'identifiers',
      'row_values',
      'balances',
      'source_links',
      'artifact_links',
      'idempotency_receipt',
    ];
    const requiredSet = new Set(required);
    const failureCode = error instanceof PlusOneError ? error.code : 'readback_execution_failed';
    return ReadbackResultSchemaV1.parse({
      schemaName: 'mutation-readback',
      schemaVersion: 1,
      readbackId: this.dependencies.newReadbackId(),
      commandId: command.commandId,
      receiptId: receipt.receiptId,
      ok: false,
      checks: allKinds.map((kind) => requiredSet.has(kind)
        ? { kind, status: 'failed', detailCode: failureCode }
        : { kind, status: 'not_applicable' }),
      mismatches: ['readback_error.' + failureCode],
      observedStateHash: hashArtifact({ failureCode }),
    });
  }

  private async requireVerifiedReplay(command: CheckedCommandV1) {
    const receipt = await this.dependencies.commands.findReceiptByCommand(
      command.householdId,
      command.commandId,
    );
    const readback = await this.dependencies.commands.findReadbackByCommand(
      command.householdId,
      command.commandId,
    );
    if (receipt === undefined || readback?.ok !== true) {
      throw new PlusOneError({
        category: 'constraint_violation',
        code: 'verified_command_evidence_missing',
        message: 'Read-back-verified command is missing receipt or read-back evidence',
        retry: 'never',
        receiptLookupRequired: true,
        details: { commandId: command.commandId },
      });
    }
    return { status: 'readback_verified' as const, receipt, readback };
  }

  private failureCategory(error: unknown): string {
    return error instanceof PlusOneError ? error.category : 'runtime_failure';
  }
}
