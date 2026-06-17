import {
  ArtifactIdSchema,
  CheckerVerdictSchemaV1,
  HouseholdIdSchema,
  PlusOneError,
  TaskIdSchema,
  type CheckerVerdictV1,
  type JsonValue,
  type RuntimePolicyV1,
  type TaskStatusV1,
} from '@plus-one/contracts';
import { ArtifactStore, createArtifactEnvelope } from './artifacts/artifact-store.js';
import type { VerificationLedgerPort, VerificationTaskSnapshot } from './ledger/ports.js';
import { RuntimePolicyRegistry } from './runtime-policy.js';
import { assertAllowedTransition, isTerminalStatus } from './state-machine.js';

interface TaskIdentity {
  householdId: string;
  taskId: string;
}

export class VerificationRuntime {
  constructor(
    private readonly dependencies: {
      ledger: VerificationLedgerPort;
      artifacts: ArtifactStore;
      policies: RuntimePolicyRegistry;
    },
  ) {}

  createTask(
    input: TaskIdentity & {
      parentTaskId?: string;
      team: string;
      attemptLimit: number;
      deadlineAt?: string;
    },
  ) {
    return this.dependencies.ledger.createTask(input);
  }

  async selectContract(
    input: TaskIdentity & {
      skill: { skillName: string; skillVersion: number; contentHash: string };
      inputSchema: { schemaName: string; schemaVersion: number };
      outputSchema: { schemaName: string; schemaVersion: number };
      policy: RuntimePolicyV1['identity'];
    },
  ): Promise<VerificationTaskSnapshot> {
    const policy = this.dependencies.policies.resolve(input.policy);
    await this.dependencies.ledger.selectExecutionContract({ ...input, policy });
    return this.move(input, 'created', 'skill_selected', 'execution_contract_selected');
  }

  beginMaker(identity: TaskIdentity): Promise<VerificationTaskSnapshot> {
    return this.moveFromCurrent(
      identity,
      ['skill_selected', 'revision_requested'],
      'maker_running',
      'maker_started',
    );
  }

  async validateMaker(
    input: TaskIdentity & {
      artifactId: string;
      schema: { schemaName: string; schemaVersion: number };
      payload: JsonValue;
    },
  ) {
    const task = await this.requireStatus(input, 'maker_running');
    const artifact = createArtifactEnvelope({
      householdId: HouseholdIdSchema.parse(input.householdId),
      taskId: TaskIdSchema.parse(input.taskId),
      artifactId: ArtifactIdSchema.parse(input.artifactId),
      artifactType: 'maker_output',
      schema: input.schema,
      payload: input.payload,
    });

    await this.dependencies.artifacts.save(artifact);
    await this.dependencies.ledger.linkMakerArtifact({
      ...input,
      artifactId: artifact.artifactId,
      artifactHash: artifact.artifactHash,
    });
    await this.move(input, task.status, 'maker_validated', 'maker_artifact_validated');
    return artifact;
  }

  beginChecker(identity: TaskIdentity): Promise<VerificationTaskSnapshot> {
    return this.move(identity, 'maker_validated', 'checker_running', 'checker_started');
  }

  async validateChecker(
    input: TaskIdentity & {
      checkerArtifactId: string;
      verdict: CheckerVerdictV1;
    },
  ) {
    await this.requireStatus(input, 'checker_running');
    const verdict = CheckerVerdictSchemaV1.parse(input.verdict);
    const checkerArtifact = createArtifactEnvelope({
      householdId: HouseholdIdSchema.parse(input.householdId),
      taskId: TaskIdSchema.parse(input.taskId),
      artifactId: ArtifactIdSchema.parse(input.checkerArtifactId),
      artifactType: 'checker_output',
      schema: { schemaName: 'checker-verdict', schemaVersion: 1 },
      payload: verdict,
    });

    await this.dependencies.artifacts.save(checkerArtifact);
    await this.dependencies.ledger.recordCheckerVerdict({
      ...input,
      checkerArtifactId: checkerArtifact.artifactId,
      verdict,
    });
    await this.move(input, 'checker_running', 'checker_validated', 'checker_artifact_validated');
    return checkerArtifact;
  }

  async requestRevision(identity: TaskIdentity): Promise<VerificationTaskSnapshot> {
    const verdict = await this.dependencies.ledger.findLatestVerdict(
      identity.householdId,
      identity.taskId,
    );

    if (verdict?.verdict !== 'revision_requested') {
      throw new PlusOneError({
        category: 'checker_rejected',
        code: 'revision_verdict_required',
        message: 'Revision requires a checker revision verdict',
        retry: 'never',
        receiptLookupRequired: false,
        details: { taskId: identity.taskId },
      });
    }

    return this.move(
      identity,
      'checker_validated',
      'revision_requested',
      'checker_requested_revision',
    );
  }

  async complete(
    identity: TaskIdentity & {
      status: Extract<
        TaskStatusV1,
        'verified' | 'partial' | 'insufficient_evidence' | 'conflicted' | 'failed'
      >;
    },
  ) {
    const task = await this.requireTask(identity);
    const verdict = await this.dependencies.ledger.findLatestVerdict(
      identity.householdId,
      identity.taskId,
    );

    if (identity.status === 'verified' && verdict?.verdict !== 'accepted') {
      throw new PlusOneError({
        category: 'checker_rejected',
        code: 'checker_acceptance_required',
        message: 'Verified completion requires an accepting checker verdict',
        retry: 'never',
        receiptLookupRequired: false,
        details: { taskId: identity.taskId },
      });
    }

    const expected: TaskStatusV1 =
      task.status === 'readback_verified' ? 'readback_verified' : 'checker_validated';

    return this.move(
      identity,
      expected,
      identity.status,
      `task_${identity.status}`,
      true,
      identity.status === 'failed' ? 'runtime_failure' : undefined,
      false,
    );
  }

  fail(
    identity: TaskIdentity & {
      expectedFrom: TaskStatusV1;
      failureCategory: string;
      resumable: boolean;
    },
  ) {
    return this.move(
      identity,
      identity.expectedFrom,
      'failed',
      'runtime_failed',
      true,
      identity.failureCategory,
      identity.resumable,
    );
  }

  private async moveFromCurrent(
    identity: TaskIdentity,
    allowedFrom: readonly TaskStatusV1[],
    to: TaskStatusV1,
    reason: string,
  ) {
    const task = await this.requireTask(identity);

    if (!allowedFrom.includes(task.status)) {
      throw this.invalidTransition(task.status, to);
    }

    return this.move(identity, task.status, to, reason);
  }

  private async move(
    identity: TaskIdentity,
    from: TaskStatusV1,
    to: TaskStatusV1,
    reasonCode: string,
    terminal = isTerminalStatus(to),
    failureCategory?: string,
    resumable?: boolean,
  ) {
    assertAllowedTransition(from, to);
    const transition = {
      ...identity,
      expectedFrom: from,
      to,
      reasonCode,
      responsibleComponent: 'VerificationRuntime',
      terminal,
      ...(failureCategory === undefined ? {} : { failureCategory }),
      ...(resumable === undefined ? {} : { resumable }),
    };

    return this.dependencies.ledger.transition(transition);
  }

  private async requireStatus(identity: TaskIdentity, expected: TaskStatusV1) {
    const task = await this.requireTask(identity);

    if (task.status !== expected) {
      throw this.invalidTransition(task.status, expected);
    }

    return task;
  }

  private async requireTask(identity: TaskIdentity) {
    const task = await this.dependencies.ledger.findTask(identity.householdId, identity.taskId);

    if (task === undefined) {
      throw new PlusOneError({
        category: 'validation_rejected',
        code: 'task_not_found',
        message: 'Verification task was not found',
        retry: 'never',
        receiptLookupRequired: false,
        details: { taskId: identity.taskId },
      });
    }

    return task;
  }

  private invalidTransition(from: TaskStatusV1, to: TaskStatusV1) {
    return new PlusOneError({
      category: 'constraint_violation',
      code: 'invalid_task_transition',
      message: `Invalid task transition ${from} -> ${to}`,
      retry: 'never',
      receiptLookupRequired: false,
      details: { from, to },
    });
  }
}
