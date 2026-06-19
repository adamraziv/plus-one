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
  PeriodCloseProposalSchemaV1,
  PeriodReopenProposalSchemaV1,
  PeriodCloseService,
  ReconciliationProposalSchemaV1,
  ReconciliationRepository,
  SourceExtractor,
  createClosePeriodHandler,
  createConfirmImportBatchHandler,
  createRecordReconciliationHandler,
  createReopenPeriodHandler,
  type ConfirmImportBatchProposalV1,
  type PeriodCloseProposalV1,
  type PeriodReopenProposalV1,
  type ReconciliationProposalV1,
} from '@plus-one/ingestion';
import {
  PostgresDomainCommandBridge,
  PostgresMutationCommandRepository,
  PostgresVerificationLedgerRepository,
} from '@plus-one/database';
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
  closeArtifactId: id('artifact', 41),
  reopenArtifactId: id('artifact', 43),
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
  checkedExistingMatch(existingJournalId: string): Promise<CheckedCommandV1>;
  postExistingJournal(): Promise<{ journalId: string }>;
  execute(command: CheckedCommandV1): ReturnType<ReturnType<typeof createExecutor>['executor']['execute']>;
  confirm(command: CheckedCommandV1): Promise<CheckedCommandV1>;
  confirmAndExecute(command: CheckedCommandV1): ReturnType<ReturnType<typeof createExecutor>['executor']['execute']>;
  commitImportWithoutReadback(): Promise<CheckedCommandV1>;
  recordCheckedReconciliation(): ReturnType<ReturnType<typeof createExecutor>['executor']['execute']>;
  closePeriod(): ReturnType<ReturnType<typeof createExecutor>['executor']['execute']>;
  reopenPeriod(): ReturnType<ReturnType<typeof createExecutor>['executor']['execute']>;
  executeReopenWithoutConfirmation(): ReturnType<ReturnType<typeof createExecutor>['executor']['execute']>;
  periodEvents(): Promise<string[]>;
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
  const confirmImportHandler = createConfirmImportBatchHandler({
    repository: ingestion,
    repositoryForClient: (transactionClient) => new IngestionRepository(transactionClient),
    drafts: new JournalDraftRepository(),
    posting: new JournalPostingService(),
  });
  const executor = createExecutor(context, [
    confirmImportHandler,
    createRecordReconciliationHandler(
      reconciliation,
      (transactionClient) => new ReconciliationRepository(transactionClient),
    ),
    createClosePeriodHandler(
      new PeriodCloseService(reconciliation),
      (transactionClient) => new PeriodCloseService(new ReconciliationRepository(transactionClient)),
    ),
    createReopenPeriodHandler(
      new PeriodCloseService(reconciliation),
      (transactionClient) => new PeriodCloseService(new ReconciliationRepository(transactionClient)),
    ),
  ]);
  let batch: { importBatchId: string; normalizedRowId: string } | undefined;
  let confirmationRecorded = false;
  let reconciliationRecorded = false;
  let closeExecuted = false;
  let preparedReopen: CheckedCommandV1 | undefined;

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
    const proposal = checkedImportProposal(current.importBatchId, 'post');
    const payload = toJson(proposal);
    const hash = await seedCheckedArtifact(owner, payload, {
      taskId: ingestionIds.taskId,
      artifactId: ingestionIds.artifactId,
      checkerArtifactId: id('artifact', 40),
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

  async function checkedExistingMatch(existingJournalId: string): Promise<CheckedCommandV1> {
    const current = batch ?? await receive();
    const proposal = checkedImportProposal(current.importBatchId, 'link_existing', existingJournalId);
    const payload = toJson(proposal);
    const hash = await seedCheckedArtifact(owner, payload, {
      taskId: id('task', 24),
      artifactId: id('artifact', 47),
      checkerArtifactId: id('artifact', 48),
      outputSchema: { schemaName: 'confirm-import-batch-proposal', schemaVersion: 1 },
    });
    await ingestion.transitionBatch(current.importBatchId, 'normalized', 'checked', {
      id: id('artifact', 47),
      hash,
    });
    await ingestion.transitionBatch(current.importBatchId, 'checked', 'awaiting_confirmation');
    return commandFor({
      commandId: id('command', 24),
      idempotencyKey: id('idem', 24),
      commandType: 'confirm_import_batch',
      taskId: id('task', 24),
      artifactId: id('artifact', 47),
      artifactHash: hash,
      payloadSchema: { schemaName: 'confirm-import-batch-proposal', schemaVersion: 1 },
      payload,
    });
  }

  async function postExistingJournal(): Promise<{ journalId: string }> {
    const payload = toJson(existingJournalProposal());
    const hash = await seedCheckedArtifact(owner, payload, {
      taskId: id('task', 30),
      artifactId: id('artifact', 59),
      checkerArtifactId: id('artifact', 60),
      outputSchema: { schemaName: 'post-journal-proposal', schemaVersion: 1 },
    });
    const transactionClient = await accounting.connect();
    try {
      await transactionClient.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const proposal = existingJournalProposal();
      const draft = {
        schemaName: 'journal-draft-input',
        schemaVersion: 1,
        householdId,
        bookId,
        draftId: proposal.draftId,
        draftSeriesId: id('draftseries', 30),
        version: 1,
        taskId: proposal.taskId,
        checkedArtifactId: id('artifact', 59),
        checkedArtifactHash: hash,
        journalType: proposal.journalType,
        transactionCurrency: proposal.transactionCurrency,
        occurredOn: proposal.occurredOn,
        effectiveOn: proposal.effectiveOn,
        description: proposal.description,
        tagIds: proposal.tagIds,
        postings: proposal.postings,
      };
      await new JournalDraftRepository().insertVersion(transactionClient, draft as never);
      await new JournalPostingService().postInTransaction(transactionClient, {
        ...proposal,
        schemaName: 'post-journal-input',
        checkedArtifactId: id('artifact', 59),
        checkedArtifactHash: hash,
      } as never);
      await transactionClient.query('COMMIT');
      return { journalId: id('journal', 30) };
    } catch (error) {
      await transactionClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      transactionClient.release();
    }
  }

  async function confirmAndExecute(command: CheckedCommandV1) {
    return executor.executor.execute(await confirm(command));
  }

  async function confirm(command: CheckedCommandV1): Promise<CheckedCommandV1> {
    if (!confirmationRecorded) {
      await recordConfirmation(command, ingestionIds.confirmationId);
      confirmationRecorded = true;
    }
    return CheckedCommandSchemaV1.parse({
      ...command,
      confirmationId: ingestionIds.confirmationId,
    });
  }

  async function recordConfirmation(command: CheckedCommandV1, confirmationId: string) {
    await commands.recordConfirmation(ExternalConfirmationSchemaV1.parse({
      schemaName: 'external-confirmation',
      schemaVersion: 1,
      confirmationId,
      householdId,
      taskId: command.taskId,
      checkedProposalId: command.checkedProposalId,
      checkedProposalHash: command.checkedProposalHash,
      principalId: 'principal:telegram:20',
      channel: 'telegram',
      channelReference: confirmationId,
      confirmedAt: '2026-06-18T00:00:00.000Z',
    }));
  }

  async function commitImportWithoutReadback(): Promise<CheckedCommandV1> {
    const command = await confirm(await checkedImport());
    await commands.register(command, true);
    await new PostgresVerificationLedgerRepository(operations).transition({
      householdId: command.householdId,
      taskId: command.taskId,
      expectedFrom: 'checker_validated',
      to: 'execution_pending',
      reasonCode: 'test_execution_pending',
      responsibleComponent: 'IngestionHarness',
    });
    await commands.markExecutionPending(command.householdId, command.commandId);
    const transactionClient = await accounting.connect();
    try {
      await transactionClient.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const bridge = new PostgresDomainCommandBridge();
      await bridge.claim(transactionClient, command.householdId, command.commandId);
      const output = await confirmImportHandler.execute(
        transactionClient,
        ConfirmImportBatchProposalSchemaV1.parse(command.payload),
        command,
      );
      await bridge.commit(transactionClient, {
        householdId: command.householdId,
        commandId: command.commandId,
        receiptId: command.commandId.replace(/^command_/, 'receipt_'),
        committedRecords: output.committedRecords,
        expectedState: output.expectedState,
        expectedStateHash: hashArtifact(output.expectedState),
      });
      await transactionClient.query('COMMIT');
    } catch (error) {
      await transactionClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      transactionClient.release();
    }
    return command;
  }

  async function recordCheckedReconciliation() {
    const current = batch ?? await receive();
    const lineage = await ingestion.readSourceLineage(current.normalizedRowId) as { sourceDocumentId: string };
    await reconciliation.insertStatementSnapshot({
      statementSnapshotId: ingestionIds.statementSnapshotId,
      householdId,
      sourceDocumentId: lineage.sourceDocumentId,
      accountId: accounts.cash,
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30',
      currency: 'USD',
      openingBalance: '100.00',
      closingBalance: '80.00',
    });
    const payload = toJson(reconciliationProposal());
    const hash = await seedCheckedArtifact(owner, payload, {
      taskId: id('task', 21),
      artifactId: id('artifact', 41),
      checkerArtifactId: id('artifact', 42),
      outputSchema: { schemaName: 'reconciliation-proposal', schemaVersion: 1 },
    });
    reconciliationRecorded = true;
    return executor.executor.execute(commandFor({
      commandId: id('command', 21),
      idempotencyKey: id('idem', 21),
      commandType: 'record_reconciliation',
      taskId: id('task', 21),
      artifactId: id('artifact', 41),
      artifactHash: hash,
      payloadSchema: { schemaName: 'reconciliation-proposal', schemaVersion: 1 },
      payload,
    }));
  }

  async function closePeriod() {
    if (!reconciliationRecorded) await recordCheckedReconciliation();
    const payload = toJson(closeProposal());
    const hash = await seedCheckedArtifact(owner, payload, {
      taskId: id('task', 22),
      artifactId: id('artifact', 43),
      checkerArtifactId: id('artifact', 44),
      outputSchema: { schemaName: 'period-close-proposal', schemaVersion: 1 },
    });
    closeExecuted = true;
    return executor.executor.execute(commandFor({
      commandId: id('command', 22),
      idempotencyKey: id('idem', 22),
      commandType: 'close_accounting_period',
      taskId: id('task', 22),
      artifactId: id('artifact', 43),
      artifactHash: hash,
      payloadSchema: { schemaName: 'period-close-proposal', schemaVersion: 1 },
      payload,
    }));
  }

  async function reopenCommand(): Promise<CheckedCommandV1> {
    if (preparedReopen !== undefined) return preparedReopen;
    if (!closeExecuted) await closePeriod();
    const latest = await reconciliation.readLatestPeriodEvent(householdId, bookId, periodId) as {
      periodEventId: string;
    };
    const payload = toJson(reopenProposalFor(latest.periodEventId));
    const hash = await seedCheckedArtifact(owner, payload, {
      taskId: id('task', 23),
      artifactId: id('artifact', 45),
      checkerArtifactId: id('artifact', 46),
      outputSchema: { schemaName: 'period-reopen-proposal', schemaVersion: 1 },
    });
    preparedReopen = commandFor({
      commandId: id('command', 23),
      idempotencyKey: id('idem', 23),
      commandType: 'reopen_accounting_period',
      taskId: id('task', 23),
      artifactId: id('artifact', 45),
      artifactHash: hash,
      payloadSchema: { schemaName: 'period-reopen-proposal', schemaVersion: 1 },
      payload,
    });
    return preparedReopen;
  }

  async function reopenPeriod() {
    const command = await reopenCommand();
    const confirmationId = id('confirm', 23);
    await recordConfirmation(command, confirmationId);
    return executor.executor.execute(CheckedCommandSchemaV1.parse({ ...command, confirmationId }));
  }

  return {
    receive,
    checkedImport,
    checkedExistingMatch,
    postExistingJournal,
    execute: (command) => executor.executor.execute(command),
    confirm,
    confirmAndExecute,
    commitImportWithoutReadback,
    recordCheckedReconciliation,
    closePeriod,
    reopenPeriod,
    executeReopenWithoutConfirmation: async () => executor.executor.execute(await reopenCommand()),
    periodEvents: async () => (await owner.query<{ event_type: string }>(
      'SELECT event_type FROM accounting.period_events ORDER BY created_at',
    )).rows.map((row) => row.event_type),
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

function checkedImportProposal(
  importBatchId: string,
  action: 'post' | 'link_existing',
  existingJournalId?: string,
): ConfirmImportBatchProposalV1 {
  return ConfirmImportBatchProposalSchemaV1.parse({
    schemaName: 'confirm-import-batch-proposal',
    schemaVersion: 1,
    householdId,
    importBatchId,
    batchVersion: 1,
    decisions: [action === 'link_existing' ? {
      normalizedRowId: ingestionIds.normalizedRowId,
      action,
      existingJournalId,
      reasonCode: 'probable_duplicate_confirmed',
    } : {
      normalizedRowId: ingestionIds.normalizedRowId,
      action,
      reasonCode: 'new_transaction',
      draft: {
        draftSeriesId: id('draftseries', 20),
        version: 1,
        journal: importJournalProposal(),
      },
    }],
  });
}

function importJournalProposal() {
  return {
    schemaName: 'post-journal-proposal' as const,
    schemaVersion: 1 as const,
    householdId,
    bookId,
    journalId: id('journal', 20),
    draftId: id('draft', 20),
    periodId,
    taskId: ingestionIds.taskId,
    journalType: 'ordinary' as const,
    transactionCurrency: 'USD',
    occurredOn: '2026-06-15',
    effectiveOn: '2026-06-15',
    description: 'Imported Burger',
    tagIds: [],
    postings: journalPostings(),
  };
}

function existingJournalProposal() {
  return {
    ...importJournalProposal(),
    journalId: id('journal', 30),
    draftId: id('draft', 30),
    taskId: id('task', 30),
    description: 'Existing Burger',
  };
}

function journalPostings() {
  return [
    {
      accountId: accounts.food,
      direction: 'debit' as const,
      transactionAmount: '20.00',
      accountNativeAmount: '20.00',
      accountNativeCurrency: 'USD',
      tagIds: [],
    },
    {
      accountId: accounts.cash,
      direction: 'credit' as const,
      transactionAmount: '20.00',
      accountNativeAmount: '20.00',
      accountNativeCurrency: 'USD',
      tagIds: [],
    },
  ];
}

function reconciliationProposal(): ReconciliationProposalV1 {
  return ReconciliationProposalSchemaV1.parse({
    schemaName: 'reconciliation-proposal',
    schemaVersion: 1,
    reconciliationId: ingestionIds.reconciliationId,
    householdId,
    bookId,
    accountId: accounts.cash,
    statementSnapshotId: ingestionIds.statementSnapshotId,
    periodStart: '2026-06-01',
    periodEnd: '2026-06-30',
    currency: 'USD',
    ledgerOpeningBalance: '100.00',
    ledgerClosingBalance: '80.00',
    statementOpeningBalance: '100.00',
    statementClosingBalance: '80.00',
    evidenceArtifactIds: [id('artifact', 41)],
    items: [],
    unresolvedDiscrepancies: [],
    completionStatus: 'reconciled',
  });
}

function closeProposal(): PeriodCloseProposalV1 {
  return PeriodCloseProposalSchemaV1.parse({
    schemaName: 'period-close-proposal',
    schemaVersion: 1,
    householdId,
    bookId,
    periodId,
    reconciliationIds: [ingestionIds.reconciliationId],
    unresolvedDiscrepancyIds: [],
    responsibleArtifactIds: [id('artifact', 41)],
  });
}

function reopenProposalFor(priorCloseEventId: string): PeriodReopenProposalV1 {
  return PeriodReopenProposalSchemaV1.parse({
    schemaName: 'period-reopen-proposal',
    schemaVersion: 1,
    householdId,
    bookId,
    periodId,
    reason: 'Correction needed',
    priorCloseEventId,
  });
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

async function seedCheckedArtifact(owner: Pool, output: JsonValue, input: {
  taskId: string;
  artifactId: string;
  checkerArtifactId: string;
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
      input.checkerArtifactId, hashArtifact(checker), canonicalizeJson(checker), checker,
    ],
  );
  await owner.query(
    `INSERT INTO operations.checker_verdicts
     (household_id, task_id, checker_artifact_id, covered_artifact_id, covered_artifact_hash, verdict)
     VALUES ($1,$2,$3,$4,$5,'accepted')`,
    [householdDbId, input.taskId, input.checkerArtifactId, input.artifactId, hash],
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
