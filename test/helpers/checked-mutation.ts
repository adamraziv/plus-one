import {
  CheckedCommandSchemaV1,
  ExternalConfirmationSchemaV1,
  PostJournalProposalSchemaV1,
  type AccountId,
  type CheckedCommandV1,
  type CurrencyCode,
  type DecimalString,
  type ExternalConfirmationV1,
  type JsonValue,
} from '@plus-one/contracts';
import {
  PostgresArtifactRepository,
  PostgresDomainCommandBridge,
  PostgresMutationCommandRepository,
  PostgresVerificationLedgerRepository,
} from '@plus-one/database';
import {
  createPostAccountingJournalHandler,
} from '@plus-one/accounting';
import {
  CheckedMutationExecutor,
  CommandRegistry,
  CommandStateResolver,
  SerializableMutationRunner,
  type MutationCommandHandler,
} from '@plus-one/mutations';
import { ArtifactStore, canonicalizeJson, hashArtifact } from '@plus-one/runtime';
import { Pool } from 'pg';
import { z } from 'zod';
import { accounts, postInput, seedLedgerScenario, type DraftSpec } from './accounting-ledger.js';
import type { PostgresTestContext } from './postgres.js';

export const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
export const taskId = 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K';
export const proposalId = 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K';
export const proposalPayload = {
  schemaName: 'test-command-input',
  schemaVersion: 1,
  amount: '20.00',
};
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

export async function seedCheckedAccountingMutation(pool: Pool): Promise<{
  spec: DraftSpec;
  command: CheckedCommandV1;
}> {
  const usd = (accountId: string, direction: 'debit' | 'credit', amount: string) => ({
    accountId: accountId as AccountId,
    direction,
    transactionAmount: amount as DecimalString,
    accountNativeAmount: amount as DecimalString,
    accountNativeCurrency: 'USD' as CurrencyCode,
    tagIds: [] as never[],
  });
  const base: DraftSpec = {
    index: 1,
    journalType: 'ordinary',
    description: 'Checked lunch',
    transactionCurrency: 'USD',
    postings: [
      usd(accounts.food, 'debit', '20.00'),
      usd(accounts.cash, 'credit', '20.00'),
    ],
  };
  const executionInput = postInput(base);
  const {
    checkedArtifactId: _artifactId,
    checkedArtifactHash: _artifactHash,
    schemaName: _schemaName,
    ...proposalBody
  } = executionInput;
  void _artifactId;
  void _artifactHash;
  void _schemaName;
  const payload = PostJournalProposalSchemaV1.parse({
    ...proposalBody,
    schemaName: 'post-journal-proposal',
    postings: proposalBody.postings.map(({ postingId: _postingId, ...posting }) => {
      void _postingId;
      return posting;
    }),
  });
  const payloadJson = JSON.parse(JSON.stringify(payload)) as JsonValue;
  const makerPayload = {
    schemaName: 'maker-artifact' as const,
    schemaVersion: 1 as const,
    outputSchema: { schemaName: 'post-journal-proposal', schemaVersion: 1 },
    output: payloadJson,
    claims: [{
      claimId: 'journal-proposal-ready',
      text: 'Balanced journal proposal is ready for checked execution.',
      evidenceArtifactIds: [],
    }],
    assumptions: [],
    uncertainty: [],
  } satisfies JsonValue;
  const spec: DraftSpec = {
    ...base,
    artifactPayload: makerPayload,
    artifactSchema: { schemaName: 'maker-artifact', schemaVersion: 1 },
    checkedArtifactHash: hashArtifact(makerPayload),
  };
  await seedLedgerScenario(pool, [spec]);
  const boundInput = postInput(spec);
  return {
    spec,
    command: CheckedCommandSchemaV1.parse({
      schemaName: 'checked-command',
      schemaVersion: 1,
      commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      householdId: payload.householdId,
      taskId: payload.taskId,
      commandType: 'post_accounting_journal',
      checkedProposalId: boundInput.checkedArtifactId,
      checkedProposalHash: boundInput.checkedArtifactHash,
      idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      payloadSchema: { schemaName: 'post-journal-proposal', schemaVersion: 1 },
      payload: payloadJson,
    }),
  };
}

export function createExecutor(testContext: PostgresTestContext,
  handlers: readonly MutationCommandHandler[] = [createPostAccountingJournalHandler()],
  defaultRole: 'accounting' | 'planning' = 'accounting'): {
  executor: CheckedMutationExecutor;
  commands: PostgresMutationCommandRepository;
  ledger: PostgresVerificationLedgerRepository;
  close(): Promise<void>;
} {
  const operations = new Pool({ connectionString: testContext.roleUrls.operations });
  const accounting = new Pool({ connectionString: testContext.roleUrls.accounting });
  const planning = new Pool({ connectionString: testContext.roleUrls.planning });
  const commands = new PostgresMutationCommandRepository(operations);
  const ledger = new PostgresVerificationLedgerRepository(operations);
  const resolver = new CommandStateResolver({ commands, ledger });
  let readbackCounter = 1;
  const connect = async (role: 'accounting' | 'planning' = defaultRole) =>
    (role === 'planning' ? planning : accounting).connect();
  const runner = new SerializableMutationRunner({
    clients: { connect },
    bridge: new PostgresDomainCommandBridge(),
    findReceipt: async (targetHouseholdId, commandId) =>
      commands.findReceiptByCommand(targetHouseholdId, commandId),
    sleep: async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: () => Date.now(),
  });
  const executor = new CheckedMutationExecutor({
    artifacts: new ArtifactStore(new PostgresArtifactRepository(operations)),
    ledger,
    commands,
    resolver,
    registry: new CommandRegistry(handlers),
    runner,
    readClients: { connect: async (role) => connect(role ?? defaultRole) },
    newReadbackId: () => 'readback_' + String(readbackCounter++).padStart(26, '0'),
  });
  return {
    executor,
    commands,
    ledger,
    close: async () => {
      await planning.end();
      await accounting.end();
      await operations.end();
    },
  };
}
