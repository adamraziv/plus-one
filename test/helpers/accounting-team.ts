import {
  canonicalizeJson, hashArtifact,
} from '@plus-one/runtime';
import type { JsonValue } from '@plus-one/contracts';
import type { Pool } from 'pg';

export interface AccountingProposalSeed {
  householdId: string;
  taskId: string;
  artifactId: string;
  outputSchema: { schemaName: string; schemaVersion: number };
  proposal: JsonValue;
  checkerArtifactId?: string;
  confirmationId?: string;
}

export async function seedAccountingProposal(owner: Pool, input: AccountingProposalSeed): Promise<{
  artifactHash: string;
}> {
  const household = await owner.query<{ id: string }>(
    `SELECT id::text FROM operations.households WHERE household_id = $1`,
    [input.householdId],
  );
  if (household.rows.length === 0) {
    await owner.query(
      `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
       VALUES ($1, 'USD', 'UTC')`, [input.householdId],
    );
  }
  const householdRow = await owner.query<{ id: string }>(
    `SELECT id::text FROM operations.households WHERE household_id = $1`, [input.householdId],
  );
  const householdDbId = householdRow.rows[0]!.id;
  const maker = {
    schemaName: 'maker-artifact' as const,
    schemaVersion: 1 as const,
    outputSchema: input.outputSchema,
    output: input.proposal,
    claims: [{ claimId: 'accounting-proposal', text: 'Checked accounting proposal.',
      evidenceArtifactIds: [] }],
    assumptions: [],
    uncertainty: [],
  };
  const artifactHash = hashArtifact(maker);
  const checkerArtifactId = input.checkerArtifactId ?? input.artifactId.replace(/J1K$/, 'J2K');
  const checkerPayload = {
    verdict: 'accepted' as const,
    coveredArtifactId: input.artifactId, coveredArtifactHash: artifactHash,
    findings: [],
  };
  const checkerHash = hashArtifact(checkerPayload);
  await owner.query(
    `INSERT INTO operations.verification_tasks
     (task_id, household_id, team, status, attempt_limit, resumable)
     VALUES ($1,$2,'accounting','checker_validated',2,false)`,
    [input.taskId, householdDbId],
  );
  await owner.query(
    `INSERT INTO operations.artifacts
     (artifact_id, household_id, task_id, artifact_type, schema_name, schema_version,
      canonicalization_version, hash_algorithm, artifact_hash, canonical_payload, payload)
     VALUES ($1,$2,$3,'maker_output','maker-artifact',1,'rfc8785-v1','sha256',$4,$5,$6),
      ($7,$2,$3,'checker_output','checker-verdict',1,'rfc8785-v1','sha256',$8,$9,$10)`,
    [input.artifactId, householdDbId, input.taskId, artifactHash,
      canonicalizeJson(maker), maker,
      checkerArtifactId, checkerHash,
      canonicalizeJson(checkerPayload), checkerPayload],
  );
  await owner.query(
    `UPDATE operations.verification_tasks
     SET current_maker_artifact_id = $3, current_maker_artifact_hash = $4
     WHERE household_id = $1 AND task_id = $2`,
    [householdDbId, input.taskId, input.artifactId, artifactHash],
  );
  await owner.query(
    `INSERT INTO operations.checker_verdicts
     (household_id, task_id, checker_artifact_id, covered_artifact_id,
      covered_artifact_hash, verdict)
     VALUES ($1,$2,$3,$4,$5,'accepted')`,
    [householdDbId, input.taskId, checkerArtifactId, input.artifactId, artifactHash],
  );
  if (input.confirmationId !== undefined) await owner.query(
    `INSERT INTO operations.external_confirmations
     (confirmation_id, household_id, task_id, checked_proposal_id, checked_proposal_hash,
      principal_id, channel, channel_reference, confirmed_at)
     VALUES ($1,$2,$3,$4,$5,'principal:opaque:test','telegram','message:1',clock_timestamp())`,
    [input.confirmationId, householdDbId, input.taskId, input.artifactId, artifactHash],
  );
  return { artifactHash };
}
