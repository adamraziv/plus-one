import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CheckedCommandSchemaV1,
  ExternalConfirmationSchemaV1,
  type CheckedCommandV1,
  type JsonValue,
} from '@plus-one/contracts';
import { JournalDraftRepository, JournalPostingService } from '@plus-one/accounting';
import {
  ConfirmImportBatchProposalSchemaV1,
  IngestionRepository,
  LocalSourceObjectStore,
  PeriodCloseService,
  ReconciliationRepository,
  SourceExtractor,
  createClosePeriodHandler,
  createConfirmImportBatchHandler,
  createRecordReconciliationHandler,
  createReopenPeriodHandler,
  type ConfirmImportBatchProposalV1,
} from '@plus-one/ingestion';
import { PostgresMutationCommandRepository } from '@plus-one/database';
import { canonicalizeJson, hashArtifact } from '@plus-one/runtime';
import { Pool } from 'pg';
import { accounts, bookId, householdId, id, periodId, seedLedgerScenario } from './accounting-ledger.js';
import { createExecutor } from './checked-mutation.js';
import { createPostgresTestContext } from './postgres.js';

export const ingestionIds = {
  taskId: id('task', 20),
  artifactId: id('artifact', 39),
  confirmationId: id('confirm', 20),
  sourceDocumentId: 'source_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  importBatchId: 'import_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  normalizedRowId: 'normrow_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  statementSnapshotId: 'snapshot_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  reconciliationId: 'recon_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  periodEventId: 'periodevent_0000000000000000000001',
};

export const importCsv = Buffer.from(
  'date,amount,currency,description,id\n2026-06-15,-20.00,USD,Burger,bank-7\n',
);

export async function createSourceRoot(): Promise<{ root: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'plus-one-ingestion-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export async function createIngestionHarness(): Promise<{
  receive(bytes?: Buffer): Promise<{ importBatchId: string; normalizedRowId: string }>;
  checkedImport(): Promise<CheckedCommandV1>;
  execute(command: CheckedCommandV1): ReturnType<ReturnType<typeof createExecutor>['executor']['execute']>;
  confirmAndExecute(command: CheckedCommandV1): ReturnType<ReturnType<typeof createExecutor>['executor']['execute']>;
  lineage(): Promise<unknown>;
  postedJournalCount(): Promise<number>;
  close(): Promise<void>;
}> {
  const context = await createPostgresTestContext('ingestion_lifecycle');
  const owner = new Pool({ connectionString: context.migratorUrl });
  const accounting = new Pool({ connectionString: context.roleUrls.accounting });
  const client = await accounting.connect();
  const operations = new Pool({ connectionString: context.roleUrls.operations });
  const sourceRoot = await createSourceRoot();

  await seedLedgerScenario(owner, []);
  const ingestion = new IngestionRepository(client);
  const reconciliation = new ReconciliationRepository(client);
  const commands = new PostgresMutationCommandRepository(operations);
  const executor = createExecutor(context, [
    createConfirmImportBatchHandler({
      repository: ingestion,
      repositoryForClient: (transactionClient) => new IngestionRepository(transactionClient),
      drafts: new JournalDraftRepository(),
      posting: new JournalPostingService(),
    }),
    createRecordReconciliationHandler(reconciliation),
    createClosePeriodHandler(new PeriodCloseService(reconciliation)),
    createReopenPeriodHandler(new PeriodCloseService(reconciliation)),
  ]);
  let batch: { importBatchId: string; normalizedRowId: string } | undefined;
  let confirmationRecorded = false;

  async function receive(bytes = importCsv): Promise<{ importBatchId: string; normalizedRowId: string }> {
    const stored = await new LocalSourceObjectStore(sourceRoot.root).put(bytes, 'text/csv');
    const source = await ingestion.insertSourceDocument({
      householdId,
      sourceAccountId: accounts.cash,
      sourceSystem: 'bank',
      uploadReference: 'telegram-message:20',
      parserVersion: 'csv-v1',
      sourceSchemaVersion: 'bank-v1',
      ...stored,
    });
    const insertedBatch = await ingestion.insertBatch(source.sourceDocumentId);
    const rows = new SourceExtractor().extract({
      mediaType: 'text/csv',
      parserVersion: 'csv-v1',
      bytes,
    });
    await ingestion.insertRawRows(insertedBatch.importBatchId, rows);
    await ingestion.transitionBatch(insertedBatch.importBatchId, 'received', 'extracted');
    const raw = await client.query<{ raw_row_id: string }>(
      `SELECT raw_row_id FROM ingestion.raw_rows raw
       JOIN ingestion.import_batches batch ON batch.id = raw.import_batch_id
       WHERE batch.import_batch_id = $1`,
      [insertedBatch.importBatchId],
    );
    await ingestion.insertNormalizedVersion({
      rawRowId: raw.rows[0]!.raw_row_id,
      normalizedRowId: ingestionIds.normalizedRowId,
      version: 1,
      occurredOn: '2026-06-15',
      amount: '-20.00',
      currency: 'USD',
      description: 'Burger',
      externalTransactionId: 'bank-7',
      parserVersion: 'csv-v1',
      normalizedPayload: { date: '2026-06-15', amount: '-20.00', description: 'Burger', id: 'bank-7' },
      warnings: [],
      exactFingerprint: '7'.repeat(64),
      fingerprintKind: 'stable_external_id',
      rowState: 'ready',
    });
    await ingestion.transitionBatch(insertedBatch.importBatchId, 'extracted', 'normalized');
    batch = { importBatchId: insertedBatch.importBatchId, normalizedRowId: ingestionIds.normalizedRowId };
    return batch;
  }

  async function checkedImport(): Promise<CheckedCommandV1> {
    const current = batch ?? await receive();
    const proposal = checkedImportProposal(current.importBatchId);
    const payload = toJson(proposal);
    const hash = await seedCheckedArtifact(owner, payload, {
      taskId: ingestionIds.taskId,
      artifactId: ingestionIds.artifactId,
      outputSchema: { schemaName: 'confirm-import-batch-proposal', schemaVersion: 1 },
    });
    await ingestion.transitionBatch(current.importBatchId, 'normalized', 'checked', {
      id: ingestionIds.artifactId,
      hash,
    });
    await ingestion.transitionBatch(current.importBatchId, 'checked', 'awaiting_confirmation');
    return commandFor({
      commandId: id('command', 20),
      idempotencyKey: id('idem', 20),
      commandType: 'confirm_import_batch',
      taskId: ingestionIds.taskId,
      artifactId: ingestionIds.artifactId,
      artifactHash: hash,
      payloadSchema: { schemaName: 'confirm-import-batch-proposal', schemaVersion: 1 },
      payload,
    });
  }

  async function confirmAndExecute(command: CheckedCommandV1) {
    if (!confirmationRecorded) {
      await commands.recordConfirmation(ExternalConfirmationSchemaV1.parse({
        schemaName: 'external-confirmation',
        schemaVersion: 1,
        confirmationId: ingestionIds.confirmationId,
        householdId,
        taskId: command.taskId,
        checkedProposalId: command.checkedProposalId,
        checkedProposalHash: command.checkedProposalHash,
        principalId: 'principal:telegram:20',
        channel: 'telegram',
        channelReference: 'telegram-message:20',
        confirmedAt: '2026-06-18T00:00:00.000Z',
      }));
      confirmationRecorded = true;
    }
    return executor.executor.execute(CheckedCommandSchemaV1.parse({
      ...command,
      confirmationId: ingestionIds.confirmationId,
    }));
  }

  return {
    receive,
    checkedImport,
    execute: (command) => executor.executor.execute(command),
    confirmAndExecute,
    lineage: async () => ingestion.readSourceLineage(ingestionIds.normalizedRowId),
    postedJournalCount: async () => Number((await owner.query(
      'SELECT count(*) AS count FROM accounting.journals',
    )).rows[0]!.count),
    close: async () => {
      client.release();
      await executor.close();
      await operations.end();
      await accounting.end();
      await owner.end();
      await sourceRoot.cleanup();
      await context.cleanup();
    },
  };
}

function checkedImportProposal(importBatchId: string): ConfirmImportBatchProposalV1 {
  return ConfirmImportBatchProposalSchemaV1.parse({
    schemaName: 'confirm-import-batch-proposal',
    schemaVersion: 1,
    householdId,
    importBatchId,
    batchVersion: 1,
    decisions: [{
      normalizedRowId: ingestionIds.normalizedRowId,
      action: 'post',
      reasonCode: 'new_transaction',
      draft: {
        draftSeriesId: id('draftseries', 20),
        version: 1,
        journal: {
          schemaName: 'post-journal-proposal',
          schemaVersion: 1,
          householdId,
          bookId,
          journalId: id('journal', 20),
          draftId: id('draft', 20),
          periodId,
          taskId: ingestionIds.taskId,
          journalType: 'ordinary',
          transactionCurrency: 'USD',
          occurredOn: '2026-06-15',
          effectiveOn: '2026-06-15',
          description: 'Imported Burger',
          tagIds: [],
          postings: [
            {
              accountId: accounts.food,
              direction: 'debit',
              transactionAmount: '20.00',
              accountNativeAmount: '20.00',
              accountNativeCurrency: 'USD',
              tagIds: [],
            },
            {
              accountId: accounts.cash,
              direction: 'credit',
              transactionAmount: '20.00',
              accountNativeAmount: '20.00',
              accountNativeCurrency: 'USD',
              tagIds: [],
            },
          ],
        },
      },
    }],
  });
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

async function seedCheckedArtifact(owner: Pool, output: JsonValue, input: {
  taskId: string;
  artifactId: string;
  outputSchema: { schemaName: string; schemaVersion: number };
}): Promise<string> {
  const maker = {
    schemaName: 'maker-artifact',
    schemaVersion: 1,
    outputSchema: input.outputSchema,
    output,
    claims: [],
    assumptions: [],
    uncertainty: [],
  } satisfies JsonValue;
  const hash = hashArtifact(maker);
  const household = await owner.query<{ id: string }>(
    'SELECT id::text FROM operations.households WHERE household_id = $1',
    [householdId],
  );
  const householdDbId = household.rows[0]!.id;
  await owner.query(
    `INSERT INTO operations.verification_tasks
     (task_id, household_id, team, status, attempt_limit, resumable)
     VALUES ($1,$2,'accounting','checker_validated',2,false)`,
    [input.taskId, householdDbId],
  );
  const checker = {
    verdict: 'accepted',
    coveredArtifactId: input.artifactId,
    coveredArtifactHash: hash,
    findings: [],
  } satisfies JsonValue;
  await owner.query(
    `INSERT INTO operations.artifacts
     (artifact_id, household_id, task_id, artifact_type, schema_name, schema_version,
      canonicalization_version, hash_algorithm, artifact_hash, canonical_payload, payload)
     VALUES
     ($1,$2,$3,'maker_output','maker-artifact',1,'rfc8785-v1','sha256',$4,$5,$6),
     ($7,$2,$3,'checker_output','checker-verdict',1,'rfc8785-v1','sha256',$8,$9,$10)`,
    [
      input.artifactId, householdDbId, input.taskId, hash, canonicalizeJson(maker), maker,
      id('artifact', 40), hashArtifact(checker), canonicalizeJson(checker), checker,
    ],
  );
  await owner.query(
    `INSERT INTO operations.checker_verdicts
     (household_id, task_id, checker_artifact_id, covered_artifact_id, covered_artifact_hash, verdict)
     VALUES ($1,$2,$3,$4,$5,'accepted')`,
    [householdDbId, input.taskId, id('artifact', 40), input.artifactId, hash],
  );
  await owner.query(
    `UPDATE operations.verification_tasks
     SET current_maker_artifact_id = $3, current_maker_artifact_hash = $4
     WHERE household_id = $1 AND task_id = $2`,
    [householdDbId, input.taskId, input.artifactId, hash],
  );
  return hash;
}

function commandFor(input: {
  commandId: string;
  idempotencyKey: string;
  commandType: string;
  taskId: string;
  artifactId: string;
  artifactHash: string;
  payloadSchema: { schemaName: string; schemaVersion: number };
  payload: JsonValue;
}): CheckedCommandV1 {
  return CheckedCommandSchemaV1.parse({
    schemaName: 'checked-command',
    schemaVersion: 1,
    commandId: input.commandId,
    householdId,
    taskId: input.taskId,
    commandType: input.commandType,
    checkedProposalId: input.artifactId,
    checkedProposalHash: input.artifactHash,
    idempotencyKey: input.idempotencyKey,
    payloadSchema: input.payloadSchema,
    payload: input.payload,
  });
}
