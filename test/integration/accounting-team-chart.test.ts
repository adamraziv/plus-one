import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import {
  AccountIdSchema,
  ArtifactEnvelopeSchemaV1,
  InboundChannelMessageSchemaV1,
  MakerArtifactSchemaV1,
  VerificationTaskSchemaV1,
} from '@plus-one/contracts';
import {
  ChartOfAccountsCommandAdapter,
  ChartWorkRequestSchemaV1,
  accountingSkills,
  createChartOfAccountsMutationHandler,
} from '@plus-one/accounting';
import { ArtifactStore } from '@plus-one/runtime';
import { createChartCheckerAgent } from '../../apps/engine/src/agents/accounting/index.js';
import { materializeAccountingLeadRequest } from '../../apps/engine/src/accounting/accounting-request-materializers.js';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';
import { seedAccountingProposal } from '../helpers/accounting-team.js';
import { createExecutor } from '../helpers/checked-mutation.js';
import { captureContractSubmission } from '../helpers/contract-agent-test-double.js';

let context: PostgresTestContext | undefined;
let close: (() => Promise<void>) | undefined;
let owner: Pool | undefined;
let accounting: Pool | undefined;
afterEach(async () => {
  await accounting?.end();
  await owner?.end();
  await close?.();
  await context?.cleanup();
  accounting = undefined; close = undefined; context = undefined; owner = undefined;
});

describe('Accounting Team chart mutation', () => {
  it('requires exact confirmations and creates one source-mapped account', async () => {
    context = await createPostgresTestContext('accounting_team_chart');
    owner = new Pool({ connectionString: context.migratorUrl });
    const ids = await seedBook(owner);
    const proposal = {
      schemaName: 'chart-of-accounts-proposal' as const, schemaVersion: 1 as const,
      action: 'create_account' as const,
      householdId: ids.householdId, bookId: ids.bookId, accountId: ids.accountId,
      name: 'Checking', accountingClass: 'asset' as const,
      normalBalance: 'debit' as const, nativeCurrency: 'USD' as never,
    };
    const confirmed = await seedAccountingProposal(owner, {
      householdId: ids.householdId, taskId: ids.taskId, artifactId: ids.artifactId,
      outputSchema: { schemaName: 'chart-of-accounts-proposal', schemaVersion: 1 },
      proposal, confirmationId: ids.confirmationId,
    });
    const command = new ChartOfAccountsCommandAdapter().buildCommand({
      commandId: ids.commandId, idempotencyKey: ids.idempotencyKey,
      confirmationId: ids.confirmationId, householdId: ids.householdId,
      taskId: ids.taskId, checkedProposalId: ids.artifactId,
      checkedProposalHash: confirmed.artifactHash,
      payloadSchema: { schemaName: 'chart-of-accounts-proposal', schemaVersion: 1 },
      payload: proposal,
    });
    const harness = createExecutor(context, [createChartOfAccountsMutationHandler()]);
    close = harness.close;
    await expect(harness.executor.execute(command)).resolves.toMatchObject({
      status: 'readback_verified', readback: { ok: true },
    });
    expect((await owner.query(
      `SELECT name, accounting_class, native_currency FROM accounting.accounts
       WHERE account_id = $1`, [ids.accountId],
    )).rows[0]).toEqual({ name: 'Checking', accounting_class: 'asset', native_currency: 'USD' });
  });

  it('creates no account when the referenced confirmation observation is absent', async () => {
    context = await createPostgresTestContext('accounting_team_chart_unconfirmed');
    owner = new Pool({ connectionString: context.migratorUrl });
    const ids = await seedBook(owner);
    const proposal = {
      schemaName: 'chart-of-accounts-proposal' as const, schemaVersion: 1 as const,
      action: 'create_account' as const,
      householdId: ids.householdId, bookId: ids.bookId, accountId: ids.accountId,
      name: 'Checking', accountingClass: 'asset' as const,
      normalBalance: 'debit' as const, nativeCurrency: 'USD' as never,
    };
    const seeded = await seedAccountingProposal(owner, {
      householdId: ids.householdId, taskId: ids.taskId, artifactId: ids.artifactId,
      outputSchema: { schemaName: 'chart-of-accounts-proposal', schemaVersion: 1 },
      proposal,
    });
    const command = new ChartOfAccountsCommandAdapter().buildCommand({
      commandId: ids.commandId, idempotencyKey: ids.idempotencyKey,
      confirmationId: ids.confirmationId, householdId: ids.householdId,
      taskId: ids.taskId, checkedProposalId: ids.artifactId,
      checkedProposalHash: seeded.artifactHash,
      payloadSchema: { schemaName: 'chart-of-accounts-proposal', schemaVersion: 1 },
      payload: proposal,
    });
    const harness = createExecutor(context, [createChartOfAccountsMutationHandler()]);
    close = harness.close;
    await expect(harness.executor.execute(command)).rejects.toMatchObject({
      code: 'exact_external_confirmation_required',
    });
    expect((await owner.query(
      'SELECT count(*)::int AS count FROM accounting.accounts WHERE account_id = $1',
      [ids.accountId],
    )).rows[0]).toEqual({ count: 0 });
  });

  it('rejects a Maker chart proposal whose identity differs from the materialized runtime identity', async () => {
    context = await createPostgresTestContext('accounting_team_chart_identity');
    owner = new Pool({ connectionString: context.migratorUrl });
    accounting = new Pool({ connectionString: context.roleUrls.accounting });
    const ids = await seedBook(owner);
    const message = InboundChannelMessageSchemaV1.parse({
      schemaName: 'inbound-channel-message',
      schemaVersion: 1,
      conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      householdId: ids.householdId,
      channel: 'telegram',
      externalMessageId: 'telegram-message-chart-1',
      receivedAt: '2026-07-14T00:00:00.000Z',
      speaker: { principalRef: 'telegram:user:1' },
      body: 'Add a checking account.',
      attachments: [],
      metadata: { destination: { chatId: 'telegram-chat-1' } },
    });
    const materialized = await materializeAccountingLeadRequest({
      pools: { accounting } as never,
      artifacts: new ArtifactStore({
        insert: async () => undefined,
        findById: async () => undefined,
        findByTaskAndHash: async () => undefined,
      }),
      message,
      allocateAccountId: () => AccountIdSchema.parse('account_01JNZQ4A9B8C7D6E5F4G3H2J2K'),
      allocateAccountMappingId: () => {
        throw new Error('Unexpected mapping allocation');
      },
      request: {
        schemaName: 'accounting-lead-request',
        schemaVersion: 1,
        intent: 'chart_of_accounts',
        request: {
          schemaName: 'chart-work-request-draft',
          schemaVersion: 1,
          action: 'create_account',
          instruction: 'Add a checking account.',
          known: {
            accountName: 'Checking',
            accountingClass: 'asset',
            normalBalance: 'debit',
            nativeCurrency: 'USD',
          },
        },
      },
    });
    const request = ChartWorkRequestSchemaV1.parse(materialized.request);
    const makerArtifact = ArtifactEnvelopeSchemaV1.parse({
      artifactId: ids.artifactId,
      householdId: ids.householdId,
      taskId: ids.taskId,
      artifactType: 'maker_output',
      schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
      canonicalizationVersion: 'rfc8785-v1',
      hashAlgorithm: 'sha256',
      artifactHash: 'a'.repeat(64),
      payload: MakerArtifactSchemaV1.parse({
        schemaName: 'maker-artifact',
        schemaVersion: 1,
        outputSchema: { schemaName: 'chart-work-result', schemaVersion: 1 },
        output: {
          schemaName: 'chart-of-accounts-proposal',
          schemaVersion: 1,
          action: 'create_account',
          householdId: request.householdId,
          bookId: request.bookId,
          accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J3K',
          name: 'Checking',
          accountingClass: 'asset',
          normalBalance: 'debit',
          nativeCurrency: 'USD',
        },
        claims: [],
        assumptions: [],
        uncertainty: [],
      }),
      createdAt: '2026-07-14T00:00:00.000Z',
    });
    const skill = accountingSkills.find((candidate) => candidate.identity.skillName === 'chart-of-accounts')!;
    const task = VerificationTaskSchemaV1.parse({
      schemaName: 'verification-task',
      schemaVersion: 1,
      householdId: ids.householdId,
      taskId: ids.taskId,
      checkerRole: { roleName: 'chart-checker', roleVersion: 1 },
      makerArtifact,
      makerInput: request,
      permittedEvidence: [],
      selectedSkill: skill.identity,
      rubric: { rubricName: 'chart-of-accounts-rubric', rubricVersion: 1, instructions: ['Check.'] },
      policyLabels: ['personalized_finance'],
      requiredOutputSchema: { schemaName: 'checker-verdict', schemaVersion: 1 },
    });
    const modelGenerate = vi.fn(async () => {
      throw new Error('model should not be called');
    });
    const checker = createChartCheckerAgent({
      models: {
        lead: { id: 'provider/lead', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
        maker: { id: 'provider/maker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
        checker: { id: 'provider/checker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      },
      tools: {},
      agentFactory: () => ({ generate: modelGenerate } as never),
    });
    const submission = captureContractSubmission();

    await checker.generate(
      [{ role: 'user', content: JSON.stringify(task) }],
      submission.options as never,
    );

    expect(modelGenerate).not.toHaveBeenCalled();
    expect(submission.submitted()).toMatchObject({
      verdict: 'revision_requested',
      findings: [{ code: 'chart_identity_mismatch' }],
    });
  });

  it.each([
    ['create_account', 'accountId'],
    ['update_account', 'accountId'],
    ['archive_account', 'accountId'],
    ['create_source_mapping', 'mappingId'],
    ['replace_source_mapping', 'archivedMappingId'],
  ] as const)('rejects a changed %s runtime %s before model checking', async (action, changedIdentity) => {
    const request = chartRequestFor(action);
    const makerArtifact = ArtifactEnvelopeSchemaV1.parse({
      artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      householdId: request.householdId,
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      artifactType: 'maker_output',
      schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
      canonicalizationVersion: 'rfc8785-v1',
      hashAlgorithm: 'sha256',
      artifactHash: 'a'.repeat(64),
      payload: MakerArtifactSchemaV1.parse({
        schemaName: 'maker-artifact',
        schemaVersion: 1,
        outputSchema: { schemaName: 'chart-work-result', schemaVersion: 1 },
        output: changedIdentityProposal(request, changedIdentity),
        claims: [],
        assumptions: [],
        uncertainty: [],
      }),
      createdAt: '2026-07-14T00:00:00.000Z',
    });
    const skill = accountingSkills.find((candidate) => candidate.identity.skillName === 'chart-of-accounts')!;
    const task = VerificationTaskSchemaV1.parse({
      schemaName: 'verification-task',
      schemaVersion: 1,
      householdId: request.householdId,
      taskId: makerArtifact.taskId,
      checkerRole: { roleName: 'chart-checker', roleVersion: 1 },
      makerArtifact,
      makerInput: request,
      permittedEvidence: [],
      selectedSkill: skill.identity,
      rubric: { rubricName: 'chart-of-accounts-rubric', rubricVersion: 1, instructions: ['Check.'] },
      policyLabels: ['personalized_finance'],
      requiredOutputSchema: { schemaName: 'checker-verdict', schemaVersion: 1 },
    });
    const modelGenerate = vi.fn(async () => {
      throw new Error('model should not be called');
    });
    const checker = createChartCheckerAgent({
      models: {
        lead: { id: 'provider/lead', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
        maker: { id: 'provider/maker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
        checker: { id: 'provider/checker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      },
      tools: {},
      agentFactory: () => ({ generate: modelGenerate } as never),
    });
    const submission = captureContractSubmission();

    await checker.generate(
      [{ role: 'user', content: JSON.stringify(task) }],
      submission.options as never,
    );

    expect(modelGenerate).not.toHaveBeenCalled();
    expect(submission.submitted()).toMatchObject({
      verdict: 'revision_requested',
      findings: [{ code: 'chart_identity_mismatch' }],
    });
  });
});

function chartRequestFor(action: 'create_account' | 'update_account' | 'archive_account' | 'create_source_mapping' | 'replace_source_mapping') {
  const base = {
    schemaName: 'chart-work-request',
    schemaVersion: 1,
    householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    instruction: 'Apply the requested chart change.',
  };
  if (action === 'archive_account') {
    return ChartWorkRequestSchemaV1.parse({
      ...base,
      action,
      accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      known: {},
    });
  }
  if (action === 'create_source_mapping') {
    return ChartWorkRequestSchemaV1.parse({
      ...base,
      action,
      accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      mappingId: 'accountmap_01JNZQ4A9B8C7D6E5F4G3H2J2K',
      known: { sourceSystem: 'bank', externalAccountId: 'checking-1' },
    });
  }
  if (action === 'replace_source_mapping') {
    return ChartWorkRequestSchemaV1.parse({
      ...base,
      action,
      accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      mappingId: 'accountmap_01JNZQ4A9B8C7D6E5F4G3H2J2K',
      archivedMappingId: 'accountmap_01JNZQ4A9B8C7D6E5F4G3H2J3K',
      known: { sourceSystem: 'bank', externalAccountId: 'checking-1' },
    });
  }
  return ChartWorkRequestSchemaV1.parse({
    ...base,
    action,
    accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    known: {
      name: 'Checking',
      accountingClass: 'asset',
      normalBalance: 'debit',
      nativeCurrency: 'USD',
    },
  });
}

function changedIdentityProposal(
  request: ReturnType<typeof ChartWorkRequestSchemaV1.parse>,
  changedIdentity: 'accountId' | 'mappingId' | 'archivedMappingId',
) {
  if (request.action === 'archive_account') {
    return {
      schemaName: 'chart-of-accounts-proposal',
      schemaVersion: 1,
      action: request.action,
      householdId: request.householdId,
      bookId: request.bookId,
      accountId: changedIdentity === 'accountId'
        ? 'account_01JNZQ4A9B8C7D6E5F4G3H2J4K'
        : request.accountId,
    };
  }
  if (request.action === 'create_source_mapping' || request.action === 'replace_source_mapping') {
    return {
      schemaName: 'chart-of-accounts-proposal',
      schemaVersion: 1,
      action: request.action,
      householdId: request.householdId,
      bookId: request.bookId,
      accountId: request.accountId,
      mappingId: changedIdentity === 'mappingId'
        ? 'accountmap_01JNZQ4A9B8C7D6E5F4G3H2J4K'
        : request.mappingId,
      ...(request.action === 'replace_source_mapping'
        ? {
          archivedMappingId: changedIdentity === 'archivedMappingId'
            ? 'accountmap_01JNZQ4A9B8C7D6E5F4G3H2J5K'
            : request.archivedMappingId,
        }
        : {}),
      sourceSystem: request.known.sourceSystem,
      externalAccountId: request.known.externalAccountId,
      metadata: {},
    };
  }
  return {
    schemaName: 'chart-of-accounts-proposal',
    schemaVersion: 1,
    action: request.action,
    householdId: request.householdId,
    bookId: request.bookId,
    accountId: changedIdentity === 'accountId'
      ? 'account_01JNZQ4A9B8C7D6E5F4G3H2J4K'
      : request.accountId,
    name: request.known.name,
    accountingClass: request.known.accountingClass,
    normalBalance: request.known.normalBalance,
    nativeCurrency: request.known.nativeCurrency,
  };
}

async function seedBook(owner: Pool) {
  const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
  const bookId = 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K';
  const household = await owner.query<{ id: string }>(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1,'USD','UTC') RETURNING id::text`, [householdId],
  );
  await owner.query(
    `INSERT INTO accounting.books (book_id, household_id, name)
     VALUES ($1,$2,'Household Book')`, [bookId, household.rows[0]!.id],
  );
  return {
    householdId, bookId,
    taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
    artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
    accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
    confirmationId: 'confirm_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
    commandId: 'command_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
    idempotencyKey: 'idem_01JNZQ4A9B8C7D6E5F4G3H2J1K' as never,
  };
}
