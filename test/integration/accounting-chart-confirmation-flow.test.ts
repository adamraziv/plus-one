import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import {
  ArtifactEnvelopeSchemaV1,
  CheckerVerdictSchemaV1,
  InboundChannelMessageSchemaV1,
  MakerArtifactSchemaV1,
  type JsonValue,
} from '@plus-one/contracts';
import {
  ChartOfAccountsProposalSchemaV1,
  createChartOfAccountsMutationHandler,
  AccountingMutationService,
} from '@plus-one/accounting';
import { CheckedMutationWorkCellCoordinator } from '@plus-one/mutations';
import {
  TeamResultAssembler,
  VerificationRuntime,
  hashArtifact,
  type CheckedWorkCellResult,
} from '@plus-one/runtime';
import { DefaultChartMutationRuntime } from '../../apps/engine/src/accounting/chart-mutation-runtime.js';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';
import { seedAccountingProposal } from '../helpers/accounting-team.js';
import { createExecutor } from '../helpers/checked-mutation.js';

const ids = {
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  checkerArtifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K',
  accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  confirmationId: 'confirm_01JNZQ4A9B8C7D6E5F4G3H2J1K',
} as const;

const proposal = ChartOfAccountsProposalSchemaV1.parse({
  schemaName: 'chart-of-accounts-proposal',
  schemaVersion: 1,
  action: 'create_account',
  householdId: ids.householdId,
  bookId: ids.bookId,
  accountId: ids.accountId,
  name: 'Bank ABC',
  accountingClass: 'asset',
  normalBalance: 'debit',
  nativeCurrency: 'IDR',
});

const maker = MakerArtifactSchemaV1.parse({
  schemaName: 'maker-artifact',
  schemaVersion: 1,
  outputSchema: { schemaName: 'chart-of-accounts-proposal', schemaVersion: 1 },
  output: proposal,
  claims: [{
    claimId: 'accounting-proposal',
    text: 'Checked accounting proposal.',
    evidenceArtifactIds: [],
  }],
  assumptions: [],
  uncertainty: [],
});
const artifactHash = hashArtifact(maker);
const makerArtifact = ArtifactEnvelopeSchemaV1.parse({
  artifactId: ids.artifactId,
  householdId: ids.householdId,
  taskId: ids.taskId,
  artifactType: 'maker_output',
  schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
  canonicalizationVersion: 'rfc8785-v1',
  hashAlgorithm: 'sha256',
  artifactHash,
  payload: maker,
  createdAt: '2026-07-16T00:00:00.000Z',
});
const checkerVerdict = CheckerVerdictSchemaV1.parse({
  verdict: 'accepted' as const,
  coveredArtifactId: ids.artifactId,
  coveredArtifactHash: artifactHash,
  findings: [],
});
const proposalJson = JSON.parse(JSON.stringify(proposal)) as JsonValue;
const checkedResult: CheckedWorkCellResult = {
  householdId: ids.householdId,
  taskId: ids.taskId,
  team: 'accounting',
  workCellId: 'chart-of-accounts',
  status: 'verified',
  completionState: 'checked_mutation_pending',
  effectRequirement: {
    kind: 'checked_mutation',
    proposalSchema: { schemaName: 'chart-of-accounts-proposal', schemaVersion: 1 },
    confirmation: 'required',
  },
  makerArtifacts: [makerArtifact],
  checkerVerdicts: [checkerVerdict],
  acceptedMaker: maker,
  completionReason: 'The exact chart proposal passed checking.',
  outstanding: [],
};

let context: PostgresTestContext | undefined;
let owner: Pool | undefined;
let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await owner?.end();
  await close?.();
  await context?.cleanup();
  context = undefined;
  owner = undefined;
  close = undefined;
});

async function setupLiveChartRuntime(testName: string) {
  context = await createPostgresTestContext(testName);
  owner = new Pool({ connectionString: context.migratorUrl });
  const household = await owner.query<{ id: string }>(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1,'USD','UTC') RETURNING id::text`,
    [ids.householdId],
  );
  await owner.query(
    `INSERT INTO operations.currency_metadata (currency_code, display_name, decimal_scale)
     VALUES ('IDR', 'Indonesian Rupiah', 2)`,
  );
  await owner.query(
    `INSERT INTO accounting.books (book_id, household_id, name)
     VALUES ($1,$2,'Household Book')`,
    [ids.bookId, household.rows[0]!.id],
  );
  await seedAccountingProposal(owner, {
    householdId: ids.householdId,
    taskId: ids.taskId,
    artifactId: ids.artifactId,
    checkerArtifactId: ids.checkerArtifactId,
    outputSchema: { schemaName: 'chart-of-accounts-proposal', schemaVersion: 1 },
    proposal: proposalJson,
  });

  const executorHarness = createExecutor(context, [createChartOfAccountsMutationHandler()]);
  close = executorHarness.close;
  const verification = new VerificationRuntime({
    ledger: executorHarness.ledger,
    artifacts: {} as never,
    policies: {} as never,
  });
  const coordinator = new CheckedMutationWorkCellCoordinator({
    teamExecutor: { executeWorkCell: vi.fn().mockResolvedValue(checkedResult) },
    mutationExecutor: executorHarness.executor,
    runtime: verification,
    ledger: executorHarness.ledger,
  });
  const runtime = new DefaultChartMutationRuntime({
    service: new AccountingMutationService(coordinator),
    assembler: new TeamResultAssembler(),
    commands: executorHarness.commands,
    coordinator,
    verification,
    nextCommandId: () => ids.commandId,
    nextIdempotencyKey: () => ids.idempotencyKey,
    nextConfirmationId: () => ids.confirmationId,
  });
  return { runtime, ledger: executorHarness.ledger };
}

const resultMetadata = {
  householdId: ids.householdId,
  resultTaskId: ids.taskId,
  team: 'accounting',
  strategyName: 'single-maker-checker',
  selectedSkill: {
    skillName: 'chart-of-accounts',
    skillVersion: 1,
    contentHash: 'b'.repeat(64),
  },
  stopCondition: {
    code: 'checked-chart',
    description: 'Return one checked chart proposal.',
  },
};

function confirmationMessage(body: string) {
  return InboundChannelMessageSchemaV1.parse({
    schemaName: 'inbound-channel-message',
    schemaVersion: 1,
    conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    householdId: ids.householdId,
    channel: 'telegram',
    externalMessageId: 'telegram-confirmation-message-1',
    receivedAt: '2026-07-16T00:00:01.000Z',
    speaker: { principalRef: 'telegram:user:1' },
    body,
    attachments: [],
    metadata: { destination: { chatId: 'telegram-chat-1' } },
  });
}

describe('accounting chart confirmation flow', () => {
  it('adds Bank ABC only after exact confirmation and read-back proof', async () => {
    const live = await setupLiveChartRuntime('accounting_chart_confirmation_flow');
    const pending = await live.runtime.prepare({
      workCellInput: { workCell: { workCellId: 'chart-of-accounts' } } as never,
      resultMetadata,
    });

    expect(pending).toMatchObject({
      status: 'partial',
      effect: { state: 'awaiting_confirmation' },
    });
    expect((await owner!.query(
      'SELECT count(*)::int AS count FROM accounting.accounts WHERE name = $1',
      ['Bank ABC'],
    )).rows[0]).toEqual({ count: 0 });

    const persisted = await live.runtime.resume({
      message: confirmationMessage('go ahead'),
      pending,
    });

    expect(persisted).toMatchObject({
      status: 'verified',
      effect: {
        state: 'persisted',
        receipt: { committedRecords: [{ recordType: 'accounting.account' }] },
        readback: { ok: true },
      },
    });
    expect((await owner!.query(
      `SELECT name, accounting_class, normal_balance, native_currency
       FROM accounting.accounts WHERE name = $1`,
      ['Bank ABC'],
    )).rows).toEqual([{
      name: 'Bank ABC',
      accounting_class: 'asset',
      normal_balance: 'debit',
      native_currency: 'IDR',
    }]);
    expect((await owner!.query(
      'SELECT name FROM reporting.accounts WHERE household_id = $1 AND name = $2',
      [ids.householdId, 'Bank ABC'],
    )).rows).toEqual([{ name: 'Bank ABC' }]);
    expect((await owner!.query(
      `SELECT
         (SELECT count(*)::int FROM operations.external_confirmations) AS confirmations,
         (SELECT count(*)::int FROM operations.mutation_commands) AS commands,
         (SELECT count(*)::int FROM operations.mutation_receipts) AS receipts,
         (SELECT count(*)::int FROM operations.mutation_readbacks WHERE ok) AS readbacks`,
    )).rows[0]).toEqual({ confirmations: 1, commands: 1, receipts: 1, readbacks: 1 });
    await expect(live.ledger.findTask(ids.householdId, ids.taskId)).resolves.toMatchObject({
      status: 'verified',
    });
  });

  it('cancels the prepared proposal without writing mutation state', async () => {
    const live = await setupLiveChartRuntime('accounting_chart_confirmation_cancel');
    const pending = await live.runtime.prepare({
      workCellInput: { workCell: { workCellId: 'chart-of-accounts' } } as never,
      resultMetadata,
    });

    await live.runtime.cancel({ pending });

    expect((await owner!.query(
      'SELECT count(*)::int AS count FROM accounting.accounts WHERE account_id = $1',
      [ids.accountId],
    )).rows[0]).toEqual({ count: 0 });
    expect((await owner!.query(
      `SELECT
         (SELECT count(*)::int FROM operations.external_confirmations) AS confirmations,
         (SELECT count(*)::int FROM operations.mutation_commands) AS commands,
         (SELECT count(*)::int FROM operations.mutation_receipts) AS receipts,
         (SELECT count(*)::int FROM operations.mutation_readbacks) AS readbacks`,
    )).rows[0]).toEqual({ confirmations: 0, commands: 0, receipts: 0, readbacks: 0 });
    await expect(live.ledger.findTask(ids.householdId, ids.taskId)).resolves.toMatchObject({
      status: 'partial',
    });
  });
});
