import { afterEach, describe, expect, it } from 'vitest';
import { PostgresMutationCommandRepository } from '@plus-one/database';
import { canonicalizeJson, hashArtifact } from '@plus-one/runtime';
import { Pool } from 'pg';
import { checkedCommand } from '../helpers/checked-mutation.js';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;

afterEach(async () => {
  await context?.cleanup();
  context = undefined;
});

const identity = {
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
};
const acceptedProposal = { amount: '20.00' };
const rejectedProposal = { amount: '30.00' };
const acceptedMakerPayload = {
  schemaName: 'maker-artifact',
  schemaVersion: 1,
  outputSchema: { schemaName: 'test-command-input', schemaVersion: 1 },
  output: acceptedProposal,
  claims: [{ claimId: 'accepted-proposal', text: 'Accepted test proposal.', evidenceArtifactIds: [] }],
  assumptions: [],
  uncertainty: [],
};
const acceptedProposalHash = hashArtifact(acceptedMakerPayload);
const rejectedMakerPayload = {
  schemaName: 'maker-artifact',
  schemaVersion: 1,
  outputSchema: { schemaName: 'test-command-input', schemaVersion: 1 },
  output: rejectedProposal,
  claims: [{ claimId: 'rejected-proposal', text: 'Rejected test proposal.', evidenceArtifactIds: [] }],
  assumptions: [],
  uncertainty: [],
};
const rejectedProposalHash = hashArtifact(rejectedMakerPayload);

describe('checked mutation schema', () => {
  it('creates only the required Plan 05 operations relations', async () => {
    context = await createPostgresTestContext('checked_mutation_relations');
    const pool = new Pool({ connectionString: context.migratorUrl });
    try {
      const result = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'operations'
           AND (table_name LIKE 'mutation_%' OR table_name = 'external_confirmations')
         ORDER BY table_name`,
      );
      expect(result.rows.map((row) => row.table_name)).toEqual([
        'external_confirmations',
        'mutation_commands',
        'mutation_readbacks',
        'mutation_receipts',
      ]);
    } finally {
      await pool.end();
    }
  });

  it('rejects a command whose payload is not the exact accepted maker artifact output', async () => {
    context = await createPostgresTestContext('checked_mutation_artifact');
    const pool = new Pool({ connectionString: context.migratorUrl });
    await seedAcceptedArtifact(pool);
    await expect(insertCommand(pool, { payload: { amount: '99.00' } }))
      .rejects.toMatchObject({ code: '23514', constraint: 'mutation_command_exact_artifact' });
    await pool.end();
  });

  it('requires a confirmation to cover the same task, artifact id, and artifact hash', async () => {
    context = await createPostgresTestContext('checked_mutation_confirmation');
    const pool = new Pool({ connectionString: context.migratorUrl });
    await seedAcceptedArtifact(pool);
    await pool.query(
      `INSERT INTO operations.external_confirmations
       (confirmation_id, household_id, task_id, checked_proposal_id, checked_proposal_hash,
        principal_id, channel, channel_reference, confirmed_at)
       SELECT 'confirm_01JNZQ4A9B8C7D6E5F4G3H2J1K', household.id, task.task_id,
        'artifact_01JNZQ4A9B8C7D6E5F4G3H2J3K', repeat('c',64), 'principal:opaque:1',
        'telegram', 'telegram-message:1', clock_timestamp()
       FROM operations.households household
       JOIN operations.verification_tasks task ON task.household_id = household.id
       WHERE household.household_id = $1`,
      [identity.householdId],
    );
    await expect(insertCommand(pool, {
      confirmationRequired: true,
      confirmationId: 'confirm_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    })).rejects.toMatchObject({ code: '23514', constraint: 'mutation_command_exact_confirmation' });
    await pool.end();
  });

  it('makes confirmations, receipts, and read-back evidence append-only', async () => {
    context = await createPostgresTestContext('checked_mutation_immutable');
    const pool = new Pool({ connectionString: context.migratorUrl });
    await seedCommittedCommand(pool);
    await expect(pool.query(
      `UPDATE operations.mutation_receipts SET expected_state = '{}' WHERE receipt_id = $1`,
      ['receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K'],
    )).rejects.toMatchObject({ code: '55000' });
    await expect(pool.query(
      `DELETE FROM operations.external_confirmations WHERE confirmation_id = $1`,
      ['confirm_01JNZQ4A9B8C7D6E5F4G3H2J1K'],
    )).rejects.toMatchObject({ code: '55000' });
    await pool.end();
  });

  it('cannot mark a command committed without a same-transaction receipt', async () => {
    context = await createPostgresTestContext('checked_mutation_receipt_guard');
    const pool = new Pool({ connectionString: context.migratorUrl });
    await seedAcceptedArtifact(pool);
    await insertCommand(pool);
    await pool.query(
      `UPDATE operations.verification_tasks SET status = 'execution_pending',
       updated_at = clock_timestamp()
       WHERE task_id = $1`,
      [identity.taskId],
    );
    await pool.query(
      `UPDATE operations.mutation_commands SET status = 'execution_pending',
       execution_started_at = clock_timestamp()
       WHERE command_id = 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K'`,
    );
    await expect(pool.query(
      `UPDATE operations.mutation_commands SET status = 'committed',
       committed_at = clock_timestamp()
       WHERE command_id = 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K'`,
    )).rejects.toMatchObject({ code: '23514', constraint: 'mutation_command_receipt_required' });
    await pool.end();
  });

  it('normalizes exact checker and confirmation constraint failures without payload leakage', async () => {
    context = await createPostgresTestContext('mutation_safe_errors');
    const owner = new Pool({ connectionString: context.migratorUrl });
    await seedRejectedArtifact(owner);
    const operations = new Pool({ connectionString: context.roleUrls.operations });
    const repository = new PostgresMutationCommandRepository(operations);
    const result = repository.register(checkedCommand({
      checkedProposalId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J4K',
      checkedProposalHash: rejectedProposalHash,
      payload: rejectedProposal,
    }));
    await expect(result).rejects.toMatchObject({
      category: 'checker_rejected',
      code: 'exact_checker_acceptance_required',
    });
    await expect(result.catch((error: unknown) => JSON.stringify(error)))
      .resolves.not.toMatch(/30\.00|INSERT INTO|postgres:\/\//);
    await operations.end();
    await owner.end();
  });

  it('uses the incomplete-command status index for restart scanning', async () => {
    context = await createPostgresTestContext('mutation_status_plan');
    const pool = new Pool({ connectionString: context.migratorUrl });
    await pool.query('SET enable_seqscan = off');
    const plan = await pool.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (COSTS OFF)
       SELECT command_id, status, updated_at
       FROM operations.mutation_commands
       WHERE status IN ('registered','execution_pending','committed')
       ORDER BY updated_at LIMIT 100`,
    );
    expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n'))
      .toContain('mutation_commands_status_updated');
    await pool.end();
  });
});

async function seedAcceptedArtifact(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1,'USD','UTC')`,
    [identity.householdId],
  );
  const household = await pool.query<{ id: string }>(
    `SELECT id::text FROM operations.households WHERE household_id = $1`,
    [identity.householdId],
  );
  const householdDbId = household.rows[0]!.id;
  await pool.query(
    `INSERT INTO operations.verification_tasks
     (task_id, household_id, team, status, attempt_limit, resumable,
      current_maker_artifact_id, current_maker_artifact_hash)
     VALUES ($1,$2,'accounting','checker_validated',2,false,NULL,NULL)`,
    [identity.taskId, householdDbId],
  );
  await pool.query(
    `INSERT INTO operations.artifacts
     (artifact_id, household_id, task_id, artifact_type, schema_name, schema_version,
      canonicalization_version, hash_algorithm, artifact_hash, canonical_payload, payload)
     VALUES
     ($3,$1,$2,'maker_output','maker-artifact',1,'rfc8785-v1','sha256',$4,$5,$6),
     ('artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K',$1,$2,'checker_output','checker-verdict',1,
      'rfc8785-v1','sha256',repeat('b',64),'{}','{}'),
     ('artifact_01JNZQ4A9B8C7D6E5F4G3H2J3K',$1,$2,'maker_output','other-input',1,
      'rfc8785-v1','sha256',repeat('c',64),'{"other":true}','{"other":true}')`,
    [
      householdDbId,
      identity.taskId,
      identity.artifactId,
      acceptedProposalHash,
      canonicalizeJson(acceptedMakerPayload),
      acceptedMakerPayload,
    ],
  );
  await pool.query(
    `INSERT INTO operations.checker_verdicts
     (household_id, task_id, checker_artifact_id, covered_artifact_id,
      covered_artifact_hash, verdict)
     VALUES ($1,$2,'artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K',$3,$4,'accepted')`,
    [householdDbId, identity.taskId, identity.artifactId, acceptedProposalHash],
  );
  await pool.query(
    `UPDATE operations.verification_tasks
     SET current_maker_artifact_id = $3, current_maker_artifact_hash = $4
     WHERE household_id = $1 AND task_id = $2`,
    [householdDbId, identity.taskId, identity.artifactId, acceptedProposalHash],
  );
}

async function seedRejectedArtifact(pool: Pool): Promise<void> {
  await seedAcceptedArtifact(pool);
  await pool.query(
    `INSERT INTO operations.artifacts
     (artifact_id, household_id, task_id, artifact_type, schema_name, schema_version,
      canonicalization_version, hash_algorithm, artifact_hash, canonical_payload, payload)
     SELECT 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J4K', household.id,
      'task_01JNZQ4A9B8C7D6E5F4G3H2J1K','maker_output','maker-artifact',1,
      'rfc8785-v1','sha256',$1,$2,$3
     FROM operations.households household
     WHERE household.household_id = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K'`,
    [rejectedProposalHash, canonicalizeJson(rejectedMakerPayload), rejectedMakerPayload],
  );
  await pool.query(
    `INSERT INTO operations.artifacts
     (artifact_id, household_id, task_id, artifact_type, schema_name, schema_version,
      canonicalization_version, hash_algorithm, artifact_hash, canonical_payload, payload)
     SELECT 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J5K', household.id,
      'task_01JNZQ4A9B8C7D6E5F4G3H2J1K','checker_output','checker-verdict',1,
      'rfc8785-v1','sha256',repeat('e',64),'{}','{}'
     FROM operations.households household
     WHERE household.household_id = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K'`,
  );
  await pool.query(
    `UPDATE operations.verification_tasks
     SET current_maker_artifact_id = 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J4K',
         current_maker_artifact_hash = $1
     WHERE task_id = 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K'`,
    [rejectedProposalHash],
  );
  await pool.query(
    `INSERT INTO operations.checker_verdicts
     (household_id, task_id, checker_artifact_id, covered_artifact_id,
      covered_artifact_hash, verdict)
     SELECT household.id,'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      'artifact_01JNZQ4A9B8C7D6E5F4G3H2J5K','artifact_01JNZQ4A9B8C7D6E5F4G3H2J4K',
      $1,'rejected'
     FROM operations.households household
     WHERE household.household_id = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K'`,
    [rejectedProposalHash],
  );
}

async function insertCommand(pool: Pool, overrides: {
  payload?: object;
  confirmationRequired?: boolean;
  confirmationId?: string;
} = {}) {
  return pool.query(
    `INSERT INTO operations.mutation_commands
     (command_id, household_id, task_id, command_type, checked_proposal_id,
      checked_proposal_hash, idempotency_key, confirmation_required, confirmation_id,
      payload_schema_name, payload_schema_version, payload)
     SELECT 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K', household.id, $2, 'test_command',
      $3, $4, 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K', $5, confirmation.id,
      'test-command-input', 1, $6
     FROM operations.households household
     LEFT JOIN operations.external_confirmations confirmation
       ON confirmation.household_id = household.id AND confirmation.confirmation_id = $7
     WHERE household.household_id = $1`,
    [
      identity.householdId,
      identity.taskId,
      identity.artifactId,
      acceptedProposalHash,
      overrides.confirmationRequired ?? false,
      JSON.stringify(overrides.payload ?? acceptedProposal),
      overrides.confirmationId ?? null,
    ],
  );
}

async function seedCommittedCommand(pool: Pool): Promise<void> {
  await seedAcceptedArtifact(pool);
  await pool.query(
    `INSERT INTO operations.external_confirmations
     (confirmation_id, household_id, task_id, checked_proposal_id, checked_proposal_hash,
      principal_id, channel, channel_reference, confirmed_at)
     SELECT 'confirm_01JNZQ4A9B8C7D6E5F4G3H2J1K', id, $2, $3, $4,
      'principal:opaque:1','telegram','telegram-message:1',clock_timestamp()
     FROM operations.households WHERE household_id = $1`,
    [identity.householdId, identity.taskId, identity.artifactId, acceptedProposalHash],
  );
  await insertCommand(pool);
  await pool.query(
    `UPDATE operations.verification_tasks SET status = 'execution_pending', updated_at = clock_timestamp()
     WHERE task_id = $1`,
    [identity.taskId],
  );
  await pool.query(
    `UPDATE operations.mutation_commands
     SET status = 'execution_pending', execution_started_at = clock_timestamp()
     WHERE command_id = 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K'`,
  );
  await pool.query(
    `SELECT * FROM operations.claim_mutation_command($1, 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K')`,
    [identity.householdId],
  );
  await pool.query(
    `SELECT * FROM operations.commit_mutation_command(
      $1, 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      'receipt_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      '[{"recordType":"test.record","recordId":"record_1"}]',
      '{"recordId":"record_1"}', repeat('d',64))`,
    [identity.householdId],
  );
  await pool.query(
    `INSERT INTO operations.mutation_readbacks
     (readback_id, household_id, command_id, receipt_id, ok, checks, mismatches, observed_state_hash)
     SELECT 'readback_01JNZQ4A9B8C7D6E5F4G3H2J1K', command.household_id, command.id, receipt.id,
      true, '[{"kind":"identifiers","status":"passed"}]', '{}', repeat('e',64)
     FROM operations.mutation_commands command
     JOIN operations.mutation_receipts receipt
       ON receipt.household_id = command.household_id AND receipt.command_id = command.id
     WHERE command.command_id = 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K'`,
  );
}
