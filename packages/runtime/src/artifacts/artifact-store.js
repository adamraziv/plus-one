import { ArtifactEnvelopeSchemaV1, PlusOneError, } from '@plus-one/contracts';
import { ulid } from 'ulid';
import { canonicalizeJson, hashArtifact } from '../canonical-json.js';
export function createArtifactEnvelope(input) {
    const payload = structuredClone(input.payload);
    return ArtifactEnvelopeSchemaV1.parse({
        artifactId: input.artifactId ?? `artifact_${ulid()}`,
        householdId: input.householdId,
        taskId: input.taskId,
        artifactType: input.artifactType,
        schema: input.schema,
        canonicalizationVersion: 'rfc8785-v1',
        hashAlgorithm: 'sha256',
        artifactHash: hashArtifact(payload),
        payload,
        createdAt: input.now ?? new Date().toISOString(),
    });
}
export class ArtifactStore {
    repository;
    constructor(repository) {
        this.repository = repository;
    }
    async save(artifact) {
        const parsed = ArtifactEnvelopeSchemaV1.parse(artifact);
        if (hashArtifact(parsed.payload) !== parsed.artifactHash) {
            throw new PlusOneError({
                category: 'validation_rejected',
                code: 'artifact_hash_mismatch',
                message: 'Artifact payload does not match its declared hash',
                retry: 'never',
                receiptLookupRequired: false,
                details: { artifactId: parsed.artifactId },
            });
        }
        await this.repository.insert(parsed, canonicalizeJson(parsed.payload));
    }
    async getVerified(artifactId) {
        const artifact = await this.repository.findById(artifactId);
        if (artifact === undefined) {
            throw new PlusOneError({
                category: 'validation_rejected',
                code: 'artifact_not_found',
                message: 'Artifact was not found',
                retry: 'never',
                receiptLookupRequired: false,
                details: { artifactId },
            });
        }
        const parsed = ArtifactEnvelopeSchemaV1.parse(artifact);
        if (hashArtifact(parsed.payload) !== parsed.artifactHash) {
            throw new PlusOneError({
                category: 'constraint_violation',
                code: 'artifact_hash_mismatch',
                message: 'Stored artifact failed hash verification',
                retry: 'never',
                receiptLookupRequired: false,
                details: { artifactId },
            });
        }
        return parsed;
    }
}
