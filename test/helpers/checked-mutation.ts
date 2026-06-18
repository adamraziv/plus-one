import {
  CheckedCommandSchemaV1,
  ExternalConfirmationSchemaV1,
  type CheckedCommandV1,
  type ExternalConfirmationV1,
} from '@plus-one/contracts';
import { canonicalizeJson, hashArtifact } from '@plus-one/runtime';
import type { Pool } from 'pg';
import { z } from 'zod';

export const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
export const taskId = 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K';
export const proposalId = 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K';
export const proposalPayload = { amount: '20.00' };
export const makerArtifactPayload = {
  schemaName: 'maker-artifact',
  schemaVersion: 1,
  outputSchema: { schemaName: 'test-command-input', schemaVersion: 1 },
  output: proposalPayload,
  claims: [{ claimId: 'test-proposal', text: 'Test proposal is ready.', evidenceArtifactIds: [] }],
  assumptions: [],
  uncertainty: [],
};
export const proposalHash = hashArtifact(makerArtifactPayload);

export function checkedCommand(
  overrides: Partial<z.input<typeof CheckedCommandSchemaV1>> = {},
): CheckedCommandV1 {
  return CheckedCommandSchemaV1.parse({
    schemaName: 'checked-command',
    schemaVersion: 1,
    commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    householdId,
    taskId,
    commandType: 'test_command',
    checkedProposalId: proposalId,
    checkedProposalHash: proposalHash,
    idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    payloadSchema: { schemaName: 'test-command-input', schemaVersion: 1 },
    payload: proposalPayload,
    ...overrides,
  });
}

export function confirmation(): ExternalConfirmationV1 {
  return ExternalConfirmationSchemaV1.parse({
    schemaName: 'external-confirmation',
    schemaVersion: 1,
    confirmationId: 'confirm_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    householdId,
    taskId,
    checkedProposalId: proposalId,
    checkedProposalHash: proposalHash,
    principalId: 'principal:opaque:1',
    channel: 'telegram',
    channelReference: 'telegram-message:1',
    confirmedAt: '2026-06-15T08:00:00.000Z',
  });
}

export async function seedCheckedProposal(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1, 'USD', 'UTC')`,
    [householdId],
  );
  const household = await pool.query<{ id: string }>(
    'SELECT id::text FROM operations.households WHERE household_id = $1',
    [householdId],
  );
  const householdDbId = household.rows[0]!.id;
  await pool.query(
    `INSERT INTO operations.verification_tasks
     (task_id, household_id, team, status, attempt_limit, resumable)
     VALUES ($1,$2,'accounting','checker_validated',2,false)`,
    [taskId, householdDbId],
  );
  await pool.query(
    `INSERT INTO operations.artifacts
     (artifact_id, household_id, task_id, artifact_type, schema_name, schema_version,
      canonicalization_version, hash_algorithm, artifact_hash, canonical_payload, payload)
     VALUES
     ($1,$2,$3,'maker_output','maker-artifact',1,'rfc8785-v1','sha256',$4,$5,$6),
     ('artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K',$2,$3,'checker_output',
      'checker-verdict',1,'rfc8785-v1','sha256',repeat('b',64),'{}','{}')`,
    [proposalId, householdDbId, taskId, proposalHash,
      canonicalizeJson(makerArtifactPayload), makerArtifactPayload],
  );
  await pool.query(
    `INSERT INTO operations.checker_verdicts
     (household_id, task_id, checker_artifact_id, covered_artifact_id,
      covered_artifact_hash, verdict)
     VALUES ($1,$2,'artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K',$3,$4,'accepted')`,
    [householdDbId, taskId, proposalId, proposalHash],
  );
  await pool.query(
    `UPDATE operations.verification_tasks
     SET current_maker_artifact_id = $3, current_maker_artifact_hash = $4
     WHERE household_id = $1 AND task_id = $2`,
    [householdDbId, taskId, proposalId, proposalHash],
  );
}
