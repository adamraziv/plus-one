import { describe, expect, it } from 'vitest';
import { ArtifactIdSchema, HouseholdIdSchema, TaskIdSchema, UtcInstantSchema, } from '@plus-one/contracts';
import { ArtifactStore, createArtifactEnvelope } from './artifact-store.js';
class MemoryArtifactRepository {
    records = new Map();
    async insert(artifact, canonicalPayload) {
        void canonicalPayload;
        if (this.records.has(artifact.artifactId)) {
            throw new Error('duplicate artifact');
        }
        this.records.set(artifact.artifactId, structuredClone(artifact));
    }
    async findById(artifactId) {
        const artifact = this.records.get(artifactId);
        return artifact === undefined ? undefined : structuredClone(artifact);
    }
}
const payload = { claims: [{ amount: '12.34', source: 'record-1' }] };
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
});
