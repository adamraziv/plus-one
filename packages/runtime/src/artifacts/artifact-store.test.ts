import { describe, expect, it } from 'vitest';
import {
  ArtifactIdSchema,
  HouseholdIdSchema,
  TaskIdSchema,
  UtcInstantSchema,
  type ArtifactEnvelopeV1,
  type JsonValue,
} from '@plus-one/contracts';
import { ArtifactStore, createArtifactEnvelope, type ArtifactRepository } from './artifact-store.js';

class MemoryArtifactRepository implements ArtifactRepository {
  readonly records = new Map<string, ArtifactEnvelopeV1>();
  readonly taskHashes = new Map<string, string>();

  async insert(artifact: ArtifactEnvelopeV1, canonicalPayload: string): Promise<void> {
    void canonicalPayload;
    const taskHashKey = [artifact.householdId, artifact.taskId, artifact.artifactHash].join(':');
    if (this.taskHashes.has(taskHashKey)) {
      throw Object.assign(new Error('duplicate artifact hash'), {
        code: '23505',
        constraint: 'artifacts_household_task_hash_unique',
      });
    }
    if (this.records.has(artifact.artifactId)) {
      throw new Error('duplicate artifact');
    }

    this.records.set(artifact.artifactId, structuredClone(artifact));
    this.taskHashes.set(taskHashKey, artifact.artifactId);
  }

  async findById(
    artifactId: ArtifactEnvelopeV1['artifactId'],
  ): Promise<ArtifactEnvelopeV1 | undefined> {
    const artifact = this.records.get(artifactId);
    return artifact === undefined ? undefined : structuredClone(artifact);
  }

  async findByTaskAndHash(input: {
    householdId: ArtifactEnvelopeV1['householdId'];
    taskId: ArtifactEnvelopeV1['taskId'];
    artifactHash: ArtifactEnvelopeV1['artifactHash'];
  }): Promise<ArtifactEnvelopeV1 | undefined> {
    const artifactId = this.taskHashes.get([input.householdId, input.taskId, input.artifactHash].join(':'));
    return artifactId === undefined ? undefined : this.findById(artifactId);
  }
}

const payload: JsonValue = { claims: [{ amount: '12.34', source: 'record-1' }] };
const householdId = HouseholdIdSchema.parse('hh_01JNZQ4A9B8C7D6E5F4G3H2J1K');
const taskId = TaskIdSchema.parse('task_01JNZQ4A9B8C7D6E5F4G3H2J1K');
const createdAt = UtcInstantSchema.parse('2026-06-14T10:00:00.000Z');
const artifactId = ArtifactIdSchema.parse('artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K');

describe('ArtifactStore', () => {
  it('freezes the exact canonical payload and verifies it on retrieval', async () => {
    const repository = new MemoryArtifactRepository();
    const store = new ArtifactStore(repository);
    const artifact = createArtifactEnvelope({
      householdId,
      taskId,
      artifactType: 'maker_output',
      schema: { schemaName: 'cash-flow-maker-output', schemaVersion: 1 },
      payload,
      now: createdAt,
      artifactId,
    });

    await store.save(artifact);
    await expect(store.getVerified(artifact.artifactId)).resolves.toEqual(artifact);
  });

  it('rejects repository corruption rather than returning an unverified artifact', async () => {
    const repository = new MemoryArtifactRepository();
    const store = new ArtifactStore(repository);
    const artifact = createArtifactEnvelope({
      householdId,
      taskId,
      artifactType: 'maker_output',
      schema: { schemaName: 'test-output', schemaVersion: 1 },
      payload,
      now: createdAt,
      artifactId,
    });

    repository.records.set(artifact.artifactId, {
      ...artifact,
      payload: { changed: true },
    });

    await expect(store.getVerified(artifact.artifactId)).rejects.toMatchObject({
      code: 'artifact_hash_mismatch',
    });
  });

  it('reuses the stored artifact when the same task saves the same payload again', async () => {
    const repository = new MemoryArtifactRepository();
    const store = new ArtifactStore(repository);
    const first = createArtifactEnvelope({
      householdId,
      taskId,
      artifactType: 'maker_output',
      schema: { schemaName: 'test-output', schemaVersion: 1 },
      payload,
      now: createdAt,
      artifactId,
    });
    const second = createArtifactEnvelope({
      householdId,
      taskId,
      artifactType: 'maker_output',
      schema: { schemaName: 'test-output', schemaVersion: 1 },
      payload,
      now: createdAt,
      artifactId: ArtifactIdSchema.parse('artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K'),
    });

    await expect(store.save(first)).resolves.toEqual(first);
    await expect(store.save(second)).resolves.toEqual(first);
  });
});
