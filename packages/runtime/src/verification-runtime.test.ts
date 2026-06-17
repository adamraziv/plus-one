import { describe, expect, it } from 'vitest';
import type {
  ArtifactEnvelopeV1,
  CheckerVerdictV1,
  RuntimePolicyV1,
} from '@plus-one/contracts';
import { ArtifactStore, type ArtifactRepository } from './artifacts/artifact-store.js';
import type { VerificationLedgerPort, VerificationTaskSnapshot } from './ledger/ports.js';
import { RuntimePolicyRegistry } from './runtime-policy.js';
import { VerificationRuntime } from './verification-runtime.js';

class MemoryArtifacts implements ArtifactRepository {
  records = new Map<string, ArtifactEnvelopeV1>();

  async insert(artifact: ArtifactEnvelopeV1): Promise<void> {
    this.records.set(artifact.artifactId, structuredClone(artifact));
  }

  async findById(
    id: ArtifactEnvelopeV1['artifactId'],
  ): Promise<ArtifactEnvelopeV1 | undefined> {
    return this.records.get(id);
  }
}

class MemoryLedger implements VerificationLedgerPort {
  task?: VerificationTaskSnapshot;
  verdict?: CheckerVerdictV1;

  async createTask(input: Parameters<VerificationLedgerPort['createTask']>[0]) {
    this.task = {
      ...input,
      status: 'created',
      resumable: true,
      updatedAt: '2026-06-14T10:00:00.000Z',
    };
    return this.task;
  }

  async selectExecutionContract() {}

  async transition(input: Parameters<VerificationLedgerPort['transition']>[0]) {
    if (this.task?.status !== input.expectedFrom) {
      throw Object.assign(new Error('stale'), { code: 'stale_task_state' });
    }

    this.task = {
      ...this.task,
      status: input.to,
      resumable: input.resumable ?? this.task.resumable,
    };
    return this.task;
  }

  async linkMakerArtifact(input: Parameters<VerificationLedgerPort['linkMakerArtifact']>[0]) {
    this.task = {
      ...this.task!,
      currentMakerArtifactId: input.artifactId,
      currentMakerArtifactHash: input.artifactHash,
    };
  }

  async recordCheckerVerdict(
    input: Parameters<VerificationLedgerPort['recordCheckerVerdict']>[0],
  ) {
    this.verdict = input.verdict;
    this.task = {
      ...this.task!,
      currentCheckerArtifactId: input.checkerArtifactId,
    };
  }

  async findLatestVerdict() {
    return this.verdict;
  }

  async findTask() {
    return this.task;
  }

  async listResumable() {
    return this.task === undefined ? [] : [this.task];
  }

  async startRun() {}
  async finishRun() {}
  async startAttempt() {}
  async finishAttempt() {}
}

const policy: RuntimePolicyV1 = {
  identity: { policyName: 'test-maker', policyVersion: 1 },
  requiredCapabilities: ['structured_output'],
  primaryModel: 'provider/model-a',
  fallbackModels: [],
  maxModelSteps: 4,
  maxToolConcurrency: 1,
  maxAttempts: 2,
  maxModelRequestRetries: 1,
  maxProcessorRetries: 0,
  maxSandboxReproductions: 0,
  callDeadlineMs: 10_000,
  teamDeadlineMs: 20_000,
  endToEndDeadlineMs: 30_000,
  maxOutputBytes: 65_536,
};

describe('VerificationRuntime', () => {
  it('cannot verify before an accepting checker covers the exact maker artifact', async () => {
    const ledger = new MemoryLedger();
    const runtime = new VerificationRuntime({
      ledger,
      artifacts: new ArtifactStore(new MemoryArtifacts()),
      policies: new RuntimePolicyRegistry({
        models: { 'provider/model-a': ['structured_output'] },
        policies: [policy],
      }),
    });
    const ids = {
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    } as const;

    await runtime.createTask({ ...ids, team: 'query', attemptLimit: 2 });
    await runtime.selectContract({
      ...ids,
      skill: {
        skillName: 'verified-lookup',
        skillVersion: 1,
        contentHash: 'a'.repeat(64),
      },
      inputSchema: { schemaName: 'query-input', schemaVersion: 1 },
      outputSchema: { schemaName: 'query-output', schemaVersion: 1 },
      policy: policy.identity,
    });
    await runtime.beginMaker(ids);
    const maker = await runtime.validateMaker({
      ...ids,
      artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      schema: { schemaName: 'query-output', schemaVersion: 1 },
      payload: { result: 'checked later' },
    });
    await runtime.beginChecker(ids);
    await expect(runtime.complete({ ...ids, status: 'verified' })).rejects.toMatchObject({
      code: 'checker_acceptance_required',
    });
    await runtime.validateChecker({
      ...ids,
      checkerArtifactId: 'artifact_11JNZQ4A9B8C7D6E5F4G3H2J1K',
      verdict: {
        verdict: 'accepted',
        coveredArtifactId: maker.artifactId,
        coveredArtifactHash: maker.artifactHash,
        findings: [],
      },
    });
    await expect(runtime.complete({ ...ids, status: 'verified' })).resolves.toMatchObject({
      status: 'verified',
    });
  });

  it('requires a new checker after a revision creates a new maker artifact', async () => {
    const ledger = new MemoryLedger();
    const runtime = new VerificationRuntime({
      ledger,
      artifacts: new ArtifactStore(new MemoryArtifacts()),
      policies: new RuntimePolicyRegistry({
        models: { 'provider/model-a': ['structured_output'] },
        policies: [policy],
      }),
    });
    const ids = {
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    } as const;

    await runtime.createTask({ ...ids, team: 'query', attemptLimit: 2 });
    await runtime.selectContract({
      ...ids,
      skill: {
        skillName: 'verified-lookup',
        skillVersion: 1,
        contentHash: 'a'.repeat(64),
      },
      inputSchema: { schemaName: 'query-input', schemaVersion: 1 },
      outputSchema: { schemaName: 'query-output', schemaVersion: 1 },
      policy: policy.identity,
    });
    await runtime.beginMaker(ids);
    const first = await runtime.validateMaker({
      ...ids,
      artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      schema: { schemaName: 'query-output', schemaVersion: 1 },
      payload: { version: 1 },
    });
    await runtime.beginChecker(ids);
    await runtime.validateChecker({
      ...ids,
      checkerArtifactId: 'artifact_11JNZQ4A9B8C7D6E5F4G3H2J1K',
      verdict: {
        verdict: 'revision_requested',
        coveredArtifactId: first.artifactId,
        coveredArtifactHash: first.artifactHash,
        findings: [{ code: 'missing_scope', message: 'Scope is incomplete' }],
      },
    });
    await runtime.requestRevision(ids);
    await runtime.beginMaker(ids);
    await runtime.validateMaker({
      ...ids,
      artifactId: 'artifact_21JNZQ4A9B8C7D6E5F4G3H2J1K',
      schema: { schemaName: 'query-output', schemaVersion: 1 },
      payload: { version: 2 },
    });
    await expect(runtime.complete({ ...ids, status: 'verified' })).rejects.toMatchObject({
      code: 'checker_acceptance_required',
    });
  });
});
