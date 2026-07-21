import { afterEach, describe, expect, it } from 'vitest';
import {
  ArtifactIdSchema,
  HouseholdIdSchema,
  InboundChannelMessageSchemaV1,
  TaskIdSchema,
  UtcInstantSchema,
} from '@plus-one/contracts';
import {
  closeDatabasePools,
  createDatabasePools,
  PostgresArtifactRepository,
  type DatabasePools,
} from '@plus-one/database';
import { ArtifactStore, createArtifactEnvelope } from '@plus-one/runtime';
import { Pool } from 'pg';
import { materializeAccountingLeadRequest } from '../../apps/engine/src/accounting/accounting-request-materializers.js';
import { accounts, householdId, id, seedLedgerScenario } from '../helpers/accounting-ledger.js';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

let context: PostgresTestContext | undefined;
let owner: Pool | undefined;
let pools: DatabasePools | undefined;

afterEach(async () => {
  if (pools !== undefined) await closeDatabasePools(pools).catch(() => undefined);
  await owner?.end();
  await context?.cleanup();
  context = undefined;
  owner = undefined;
  pools = undefined;
});

describe('accounting request materializers', () => {
  it('loads accepted maker evidence through the accounting role for import and reconciliation work', async () => {
    context = await createPostgresTestContext('accounting_request_materializers');
    owner = new Pool({ connectionString: context.migratorUrl });
    pools = createDatabasePools(context.roleUrls);
    await seedLedgerScenario(owner, []);

    const taskId = TaskIdSchema.parse(id('task', 81));
    const makerArtifactId = ArtifactIdSchema.parse(id('artifact', 81));
    const checkerArtifactId = ArtifactIdSchema.parse(id('artifact', 82));
    const scopedHouseholdId = HouseholdIdSchema.parse(householdId);
    const importBatchId = 'import_01JNZQ4A9B8C7D6E5F4G3H2J1K';
    const sourceDocumentId = 'source_01JNZQ4A9B8C7D6E5F4G3H2J1K';
    const statementSnapshotId = 'snapshot_01JNZQ4A9B8C7D6E5F4G3H2J1K';
    const uploadReference = 'telegram-message-81';
    const artifacts = new ArtifactStore(new PostgresArtifactRepository(pools.operations));

    await owner.query(
      `INSERT INTO operations.verification_tasks
       (task_id, household_id, team, status, attempt_limit, resumable)
       SELECT $1, id, 'accounting', 'checker_validated', 2, false
       FROM operations.households
       WHERE household_id = $2`,
      [taskId, householdId],
    );
    const maker = createArtifactEnvelope({
      artifactId: makerArtifactId,
      householdId: scopedHouseholdId,
      taskId,
      artifactType: 'maker_output',
      schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
      payload: { source: 'checked bank statement' },
      now: UtcInstantSchema.parse('2026-07-14T00:00:00.000Z'),
    });
    const checker = createArtifactEnvelope({
      artifactId: checkerArtifactId,
      householdId: scopedHouseholdId,
      taskId,
      artifactType: 'checker_output',
      schema: { schemaName: 'checker-verdict', schemaVersion: 1 },
      payload: {
        verdict: 'accepted',
        coveredArtifactId: maker.artifactId,
        coveredArtifactHash: maker.artifactHash,
        findings: [],
      },
      now: UtcInstantSchema.parse('2026-07-14T00:00:01.000Z'),
    });
    await artifacts.save(maker);
    await artifacts.save(checker);
    await owner.query(
      `INSERT INTO operations.checker_verdicts
       (household_id, task_id, checker_artifact_id, covered_artifact_id, covered_artifact_hash, verdict)
       SELECT household.id, $1, $2, $3, $4, 'accepted'
       FROM operations.households household
       WHERE household.household_id = $5`,
      [taskId, checker.artifactId, maker.artifactId, maker.artifactHash, householdId],
    );
    await owner.query(
      `INSERT INTO ingestion.source_documents
       (source_document_id, household_id, source_account_id, source_system, content_hash,
        byte_size, storage_key, media_type, parser_version, source_schema_version,
        extraction_status, upload_reference)
       SELECT $1, household.id, account.id, 'bank', $2, 1, $3,
        'text/csv', 'csv-v1', 'bank-v1', 'received', $4
       FROM operations.households household
       JOIN accounting.accounts account ON account.household_id = household.id
       WHERE household.household_id = $5 AND account.account_id = $6`,
      [sourceDocumentId, 'a'.repeat(64), 'sha256/materializer/statement.csv', uploadReference, householdId, accounts.cash],
    );
    await owner.query(
      `INSERT INTO ingestion.import_batches
       (import_batch_id, household_id, source_document_id, state, checked_artifact_id, checked_artifact_hash)
       SELECT $1, household.id, source.id, 'awaiting_confirmation', artifact.id, artifact.artifact_hash
       FROM operations.households household
       JOIN ingestion.source_documents source ON source.household_id = household.id
       JOIN operations.artifacts artifact ON artifact.household_id = household.id
       WHERE household.household_id = $2
         AND source.source_document_id = $3
         AND artifact.artifact_id = $4`,
      [importBatchId, householdId, sourceDocumentId, maker.artifactId],
    );
    await owner.query(
      `INSERT INTO ingestion.statement_snapshots
       (statement_snapshot_id, household_id, source_document_id, account_id, period_start, period_end,
        currency, opening_balance, closing_balance)
       SELECT $1, household.id, source.id, account.id, DATE '2026-07-01', DATE '2026-07-14',
        'USD', 100, 80
       FROM operations.households household
       JOIN ingestion.source_documents source ON source.household_id = household.id
       JOIN accounting.accounts account ON account.household_id = household.id
       WHERE household.household_id = $2
         AND source.source_document_id = $3
         AND account.account_id = $4`,
      [statementSnapshotId, householdId, sourceDocumentId, accounts.cash],
    );

    const message = InboundChannelMessageSchemaV1.parse({
      schemaName: 'inbound-channel-message',
      schemaVersion: 1,
      conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      householdId,
      channel: 'telegram',
      externalMessageId: uploadReference,
      receivedAt: '2026-07-14T00:00:02.000Z',
      speaker: { principalRef: 'telegram:user:81' },
      body: `Reconcile ${uploadReference}.`,
      attachments: [],
      metadata: { destination: { chatId: 'telegram-chat-81' } },
    });
    const materializationContext = {
      pools,
      artifacts,
      message,
      allocateAccountId: () => {
        throw new Error('Unexpected account allocation');
      },
      allocateAccountMappingId: () => {
        throw new Error('Unexpected account mapping allocation');
      },
    };

    await expect(materializeAccountingLeadRequest({
      ...materializationContext,
      request: {
        schemaName: 'accounting-lead-request',
        schemaVersion: 1,
        intent: 'ingestion',
        request: {
          schemaName: 'ingestion-work-request-draft',
          schemaVersion: 1,
          instruction: 'Import the attached bank statement.',
          sourceReference: { sourceSystem: 'bank' },
        },
      },
    })).resolves.toMatchObject({
      intent: 'ingestion',
      request: {
        importBatchId,
        checkedSourceArtifact: maker,
      },
    });
    await expect(materializeAccountingLeadRequest({
      ...materializationContext,
      request: {
        schemaName: 'accounting-lead-request',
        schemaVersion: 1,
        intent: 'reconciliation',
        request: {
          schemaName: 'reconciliation-work-request-draft',
          schemaVersion: 1,
          instruction: 'Reconcile the attached bank statement.',
          accountName: 'Cash',
          statementReference: uploadReference,
          requestedOperation: 'reconcile',
        },
      },
    })).resolves.toMatchObject({
      intent: 'reconciliation',
      request: {
        accountId: accounts.cash,
        statementSnapshotId,
        checkedEvidenceArtifacts: [maker],
      },
    });
  });
});
