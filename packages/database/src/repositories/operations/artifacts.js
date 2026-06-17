import { ArtifactEnvelopeSchemaV1, ArtifactIdSchema, PlusOneError, } from '@plus-one/contracts';
export class PostgresArtifactRepository {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async insert(artifact, canonicalPayload) {
        const parsed = ArtifactEnvelopeSchemaV1.parse(artifact);
        const result = await this.pool.query(`INSERT INTO operations.artifacts
       (artifact_id, household_id, task_id, artifact_type, schema_name, schema_version,
        canonicalization_version, hash_algorithm, artifact_hash, canonical_payload, payload, created_at)
       SELECT $1, h.id, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::timestamptz
       FROM operations.households h
       WHERE h.household_id = $12`, [
            parsed.artifactId,
            parsed.taskId,
            parsed.artifactType,
            parsed.schema.schemaName,
            parsed.schema.schemaVersion,
            parsed.canonicalizationVersion,
            parsed.hashAlgorithm,
            parsed.artifactHash,
            canonicalPayload,
            JSON.stringify(parsed.payload),
            parsed.createdAt,
            parsed.householdId,
        ]);
        if (result.rowCount !== 1) {
            throw new PlusOneError({
                category: 'validation_rejected',
                code: 'artifact_household_not_found',
                message: 'Artifact household was not found',
                retry: 'never',
                receiptLookupRequired: false,
                details: { artifactId: parsed.artifactId },
            });
        }
    }
    async findById(artifactId) {
        const result = await this.pool.query(`SELECT a.artifact_id, h.household_id, a.task_id, a.artifact_type, a.schema_name,
              a.schema_version, a.canonicalization_version, a.hash_algorithm, a.artifact_hash,
              a.payload, a.created_at
       FROM operations.artifacts a
       JOIN operations.households h ON h.id = a.household_id
       WHERE a.artifact_id = $1`, [ArtifactIdSchema.parse(artifactId)]);
        const row = result.rows[0];
        if (row === undefined) {
            return undefined;
        }
        return ArtifactEnvelopeSchemaV1.parse({
            artifactId: row.artifact_id,
            householdId: row.household_id,
            taskId: row.task_id,
            artifactType: row.artifact_type,
            schema: {
                schemaName: row.schema_name,
                schemaVersion: row.schema_version,
            },
            canonicalizationVersion: row.canonicalization_version,
            hashAlgorithm: row.hash_algorithm,
            artifactHash: row.artifact_hash,
            payload: row.payload,
            createdAt: row.created_at.toISOString(),
        });
    }
}
