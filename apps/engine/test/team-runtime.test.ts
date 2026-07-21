import { describe, expect, it, vi } from 'vitest';
import {
  AccountIdSchema,
  AccountSourceMappingIdSchema,
  ArtifactIdSchema,
  EvidenceRequestSchemaV1,
  HouseholdIdSchema,
  InboundChannelMessageSchemaV1,
  MakerArtifactSchemaV1,
  MakerInvocationSchemaV1,
  TaskIdSchema,
  UtcInstantSchema,
} from '@plus-one/contracts';
import { queryTeamDefinition } from '@plus-one/query';
import {
  ChartWorkRequestSchemaV1,
  ChartWorkResultSchemaV1,
  accountingSkills,
  accountingTeamDefinition,
} from '@plus-one/accounting';
import { ArtifactStore, createArtifactEnvelope } from '@plus-one/runtime';
import { createChartMakerAgent } from '../src/agents/accounting/index.js';
import {
  deterministicLeadPlanForRequest,
  makerInputForLeadWorkItem,
  normalizeAccountingLeadRequest,
  normalizeQueryLeadRequest,
} from '../src/team-runtime.js';
import {
  accountingRequestMaterializers,
  materializeAccountingLeadRequest,
} from '../src/accounting/accounting-request-materializers.js';
import { parseDelegateTeamToolInput } from '../src/tools/delegate-team-schemas.js';
import { captureContractSubmission } from '../../../test/helpers/contract-agent-test-double.js';

const message = InboundChannelMessageSchemaV1.parse({
  schemaName: 'inbound-channel-message',
  schemaVersion: 1,
  conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  channel: 'telegram',
  externalMessageId: 'telegram-message-1',
  receivedAt: '2026-06-24T12:00:00.000Z',
  speaker: { principalRef: 'telegram:user:1' },
  body: 'add $10 of buying a burger',
  attachments: [],
  metadata: { destination: { chatId: 'telegram-chat-42' } },
});

function queryDraft(businessQuestion: string, extra: Record<string, unknown> = {}) {
  return {
    schemaName: 'query-lead-request-draft',
    schemaVersion: 1,
    businessQuestion,
    requiredCalculations: [],
    ...extra,
  };
}

function queryPools(grains: Record<string, readonly string[]>) {
  const query = vi.fn(async (_text: string, values: readonly unknown[]) => {
    const relationName = values[0];
    const grain = typeof relationName === 'string' ? grains[relationName] : undefined;
    return { rows: grain === undefined ? [] : [{ grain }] };
  });
  return { pools: { query: { query } } as never, query };
}

function unusedArtifactStore() {
  return new ArtifactStore({
    insert: async () => undefined,
    findById: async () => undefined,
    findByTaskAndHash: async () => undefined,
  });
}

function checkedArtifactStore(artifacts: ReturnType<typeof createArtifactEnvelope>[]) {
  const byId = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
  return new ArtifactStore({
    insert: async () => undefined,
    findById: async (artifactId) => byId.get(artifactId),
    findByTaskAndHash: async () => undefined,
  });
}

function checkedArtifact(artifactId: string, householdId: string = message.householdId) {
  return createArtifactEnvelope({
    artifactId: ArtifactIdSchema.parse(artifactId),
    householdId: HouseholdIdSchema.parse(householdId),
    taskId: TaskIdSchema.parse('task_01JNZQ4A9B8C7D6E5F4G3H2J1K'),
    artifactType: 'maker_output',
    schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
    payload: { source: 'accepted' },
    now: UtcInstantSchema.parse('2026-06-24T00:00:00.000Z'),
  });
}

function materializationContext(query: ReturnType<typeof vi.fn>) {
  return {
    pools: { accounting: { query } } as never,
    artifacts: unusedArtifactStore(),
    message,
    allocateAccountId: vi.fn(() => AccountIdSchema.parse('account_01JNZQ4A9B8C7D6E5F4G3H2J5K')),
    allocateAccountMappingId: vi.fn(() =>
      AccountSourceMappingIdSchema.parse('accountmap_01JNZQ4A9B8C7D6E5F4G3H2J6K')),
  };
}

describe('accounting request materializers', () => {
  it('registers every declared Accounting intent exactly once', () => {
    expect(Object.keys(accountingRequestMaterializers).sort()).toEqual([
      'chart_of_accounts',
      'ingestion',
      'journal',
      'reconciliation',
      'transaction_capture',
    ]);
  });

  it.each([
    ['create_account', 1, 0],
    ['update_account', 0, 0],
    ['archive_account', 0, 0],
    ['create_source_mapping', 0, 1],
    ['replace_source_mapping', 0, 1],
  ] as const)('uses runtime-owned identities only for the %s chart branch', async (
    action,
    expectedAccountAllocations,
    expectedMappingAllocations,
  ) => {
    const query = vi.fn(async (text: string) => {
      if (text.includes('FROM accounting.books')) {
        return { rows: [{ book_id: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' }] };
      }
      if (text.includes('FROM accounting.account_source_mappings')) {
        return { rows: [{ mapping_id: 'accountmap_01JNZQ4A9B8C7D6E5F4G3H2J7K' }] };
      }
      if (text.includes('SELECT account.account_id, account.name')) {
        return action === 'create_account'
          ? { rows: [] }
          : {
              rows: [{
                account_id: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
                name: 'Checking',
                accounting_class: 'asset',
                normal_balance: 'debit',
                native_currency: 'USD',
              }],
            };
      }
      return { rows: [{ account_id: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K' }] };
    });
    const context = materializationContext(query);

    const materialized = await materializeAccountingLeadRequest({
      ...context,
      request: {
        schemaName: 'accounting-lead-request',
        schemaVersion: 1,
        intent: 'chart_of_accounts',
        request: {
          schemaName: 'chart-work-request-draft',
          schemaVersion: 1,
          action,
          instruction: `Apply ${action}.`,
          known: {
            accountName: 'Checking',
            sourceSystem: 'bank',
            externalAccountId: 'checking-1',
          },
        },
      },
    });
    const request = ChartWorkRequestSchemaV1.parse(materialized.request);

    expect(request.householdId).toBe(message.householdId);
    expect(request.bookId).toBe('book_01JNZQ4A9B8C7D6E5F4G3H2J1K');
    expect(context.allocateAccountId).toHaveBeenCalledTimes(expectedAccountAllocations);
    expect(context.allocateAccountMappingId).toHaveBeenCalledTimes(expectedMappingAllocations);
    expect(request.accountId).toBe(action === 'create_account'
      ? 'account_01JNZQ4A9B8C7D6E5F4G3H2J5K'
      : 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K');
    if ('mappingId' in request) {
      expect(request.mappingId).toBe('accountmap_01JNZQ4A9B8C7D6E5F4G3H2J6K');
    }
    if (request.action === 'replace_source_mapping') {
      expect(request.archivedMappingId).toBe('accountmap_01JNZQ4A9B8C7D6E5F4G3H2J7K');
    }
  });

  it('resolves an unambiguous named parent but leaves missing or ambiguous parents unresolved', async () => {
    const cases = [
      [{
        account_id: 'account_01JNZQ4A9B8C7D6E5F4G3H2J3K',
        native_currency: 'USD',
        accounting_class: 'asset',
      }],
      [],
      [
        {
          account_id: 'account_01JNZQ4A9B8C7D6E5F4G3H2J3K',
          native_currency: 'USD',
          accounting_class: 'asset',
        },
        {
          account_id: 'account_01JNZQ4A9B8C7D6E5F4G3H2J4K',
          native_currency: 'USD',
          accounting_class: 'asset',
        },
      ],
    ];

    for (const rows of cases) {
      const query = vi.fn(async (text: string) => {
        if (text.includes('FROM accounting.books')) {
          return { rows: [{ book_id: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' }] };
        }
        if (text.includes('SELECT account.account_id, account.name')) return { rows: [] };
        return { rows };
      });
      const materialized = await materializeAccountingLeadRequest({
        ...materializationContext(query),
        request: {
          schemaName: 'accounting-lead-request',
          schemaVersion: 1,
          intent: 'chart_of_accounts',
          request: {
            schemaName: 'chart-work-request-draft',
            schemaVersion: 1,
            action: 'create_account',
            instruction: 'Create a savings account under assets.',
            known: { accountName: 'Savings', parentAccountName: 'Assets' },
          },
        },
      });
      const request = ChartWorkRequestSchemaV1.parse(materialized.request);

      expect(request.known.parentAccountId).toBe(rows.length === 1
        ? 'account_01JNZQ4A9B8C7D6E5F4G3H2J3K'
        : undefined);
    }
  });

  it('overrides complete chart scope, replaces create identities, and rejects out-of-scope targets', async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes('FROM accounting.books')) {
        return { rows: [{ book_id: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' }] };
      }
      if (text.includes('account.account_id = $3')) {
        return { rows: [{
          account_id: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          native_currency: 'USD',
          accounting_class: 'asset',
        }] };
      }
      return { rows: [] };
    });
    const context = materializationContext(query);
    const completeCreate = await materializeAccountingLeadRequest({
      ...context,
      request: {
        schemaName: 'accounting-lead-request',
        schemaVersion: 1,
        intent: 'chart_of_accounts',
        request: {
          schemaName: 'chart-work-request',
          schemaVersion: 1,
          householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          action: 'create_account',
          accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J3K',
          instruction: 'Create a checking account.',
          known: {},
        },
      },
    });
    const completeUpdate = await materializeAccountingLeadRequest({
      ...context,
      request: {
        schemaName: 'accounting-lead-request',
        schemaVersion: 1,
        intent: 'chart_of_accounts',
        request: {
          schemaName: 'chart-work-request',
          schemaVersion: 1,
          householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          action: 'update_account',
          accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          instruction: 'Rename checking.',
          known: { name: 'Checking' },
        },
      },
    });

    expect(ChartWorkRequestSchemaV1.parse(completeCreate.request)).toMatchObject({
      householdId: message.householdId,
      bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J5K',
    });
    expect(ChartWorkRequestSchemaV1.parse(completeUpdate.request)).toMatchObject({
      householdId: message.householdId,
      bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
    });

    const noTarget = vi.fn(async (text: string) => ({
      rows: text.includes('FROM accounting.books')
        ? [{ book_id: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' }]
        : [],
    }));
    await expect(materializeAccountingLeadRequest({
      ...materializationContext(noTarget),
      request: {
        schemaName: 'accounting-lead-request',
        schemaVersion: 1,
        intent: 'chart_of_accounts',
        request: {
          schemaName: 'chart-work-request',
          schemaVersion: 1,
          householdId: message.householdId,
          bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
          action: 'archive_account',
          accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          instruction: 'Archive checking.',
          known: {},
        },
      },
    })).rejects.toMatchObject({ code: 'chart_target_account_out_of_scope' });
  });

  it('resolves a unique checked import batch from the inbound source rather than model identifiers', async () => {
    const artifact = checkedArtifact('artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K');
    const query = vi.fn(async () => ({
      rows: [{
        import_batch_id: 'import_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        artifact_id: artifact.artifactId,
        artifact_hash: artifact.artifactHash,
        task_id: artifact.taskId,
      }],
    }));
    const context = {
      ...materializationContext(query),
      artifacts: checkedArtifactStore([artifact]),
    };

    const materialized = await materializeAccountingLeadRequest({
      ...context,
      request: {
        schemaName: 'accounting-lead-request',
        schemaVersion: 1,
        intent: 'ingestion',
        request: {
          schemaName: 'ingestion-work-request-draft',
          schemaVersion: 1,
          instruction: 'Import the attached statement.',
          sourceReference: { sourceSystem: 'bank' },
        },
      },
    });

    expect(materialized).toMatchObject({
      intent: 'ingestion',
      request: {
        schemaName: 'ingestion-work-request',
        householdId: message.householdId,
        importBatchId: 'import_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        checkedSourceArtifact: artifact,
      },
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('artifact.task_id'), [
      message.householdId,
      message.externalMessageId,
      'bank',
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('operations.checker_verdicts'), expect.anything());
  });

  it('resolves reconciliation evidence from a scoped statement snapshot instead of caller artifacts', async () => {
    const artifact = checkedArtifact('artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K');
    const reconciliationMessage = InboundChannelMessageSchemaV1.parse({
      ...message,
      body: 'Reconcile the June statement for checking.',
    });
    const query = vi.fn(async (text: string) => {
      if (text.includes('FROM accounting.books')) {
        return { rows: [{ book_id: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' }] };
      }
      if (text.includes('FROM accounting.accounts')) {
        return { rows: [{ account_id: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K' }] };
      }
      return {
        rows: [{
          statement_snapshot_id: 'snapshot_01JNZQ4A9B8C7D6E5F4G3H2J1K',
          artifact_refs: [{
            artifactId: artifact.artifactId,
            artifactHash: artifact.artifactHash,
            taskId: artifact.taskId,
          }],
        }],
      };
    });
    const context = {
      ...materializationContext(query),
      artifacts: checkedArtifactStore([artifact]),
      message: reconciliationMessage,
    };

    const materialized = await materializeAccountingLeadRequest({
      ...context,
      request: {
        schemaName: 'accounting-lead-request',
        schemaVersion: 1,
        intent: 'reconciliation',
        request: {
          schemaName: 'reconciliation-work-request-draft',
          schemaVersion: 1,
          instruction: 'Reconcile the checking statement.',
          accountName: 'Checking',
          statementReference: 'June statement',
          requestedOperation: 'reconcile',
        },
      },
    });

    expect(materialized).toMatchObject({
      intent: 'reconciliation',
      request: {
        schemaName: 'reconciliation-work-request',
        householdId: message.householdId,
        bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
        statementSnapshotId: 'snapshot_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        checkedEvidenceArtifacts: [artifact],
        requestedOperation: 'reconcile',
      },
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('operations.checker_verdicts'), expect.anything());
  });

  it('rejects checked artifacts that are not owned by the inbound household', async () => {
    const artifact = checkedArtifact(
      'artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K',
      'hh_01JNZQ4A9B8C7D6E5F4G3H2J2K',
    );
    const query = vi.fn(async () => ({
      rows: [{
        import_batch_id: 'import_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        artifact_id: artifact.artifactId,
        artifact_hash: artifact.artifactHash,
        task_id: artifact.taskId,
      }],
    }));

    await expect(materializeAccountingLeadRequest({
      ...materializationContext(query),
      artifacts: checkedArtifactStore([artifact]),
      request: {
        schemaName: 'accounting-lead-request',
        schemaVersion: 1,
        intent: 'ingestion',
        request: {
          schemaName: 'ingestion-work-request-draft',
          schemaVersion: 1,
          instruction: 'Import the attached statement.',
          sourceReference: {},
        },
      },
    })).rejects.toMatchObject({ code: 'checked_artifact_incompatible' });
  });

  it('replaces caller-supplied ingestion and reconciliation evidence with checked runtime evidence', async () => {
    const resolvedArtifact = checkedArtifact('artifact_01JNZQ4A9B8C7D6E5F4G3H2J2K');
    const callerArtifact = checkedArtifact('artifact_01JNZQ4A9B8C7D6E5F4G3H2J3K');
    const query = vi.fn(async (text: string) => {
      if (text.includes('FROM accounting.books')) {
        return { rows: [{ book_id: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' }] };
      }
      if (text.includes('FROM accounting.accounts')) {
        return {
          rows: [{
            account_id: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
            native_currency: 'USD',
          }],
        };
      }
      if (text.includes('FROM ingestion.statement_snapshots')) {
        return {
          rows: [{
            statement_snapshot_id: 'snapshot_01JNZQ4A9B8C7D6E5F4G3H2J1K',
            artifact_refs: [{
              artifactId: resolvedArtifact.artifactId,
              artifactHash: resolvedArtifact.artifactHash,
              taskId: resolvedArtifact.taskId,
            }],
          }],
        };
      }
      return {
        rows: [{
          import_batch_id: 'import_01JNZQ4A9B8C7D6E5F4G3H2J1K',
          artifact_id: resolvedArtifact.artifactId,
          artifact_hash: resolvedArtifact.artifactHash,
          task_id: resolvedArtifact.taskId,
        }],
      };
    });
    const context = {
      ...materializationContext(query),
      artifacts: checkedArtifactStore([resolvedArtifact]),
    };

    const ingestion = await materializeAccountingLeadRequest({
      ...context,
      request: {
        schemaName: 'accounting-lead-request',
        schemaVersion: 1,
        intent: 'ingestion',
        request: {
          schemaName: 'ingestion-work-request',
          schemaVersion: 1,
          householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          importBatchId: 'import_01JNZQ4A9B8C7D6E5F4G3H2J1K',
          checkedSourceArtifact: callerArtifact,
        },
      },
    });
    const reconciliation = await materializeAccountingLeadRequest({
      ...context,
      request: {
        schemaName: 'accounting-lead-request',
        schemaVersion: 1,
        intent: 'reconciliation',
        request: {
          schemaName: 'reconciliation-work-request',
          schemaVersion: 1,
          householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          accountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          statementSnapshotId: 'snapshot_01JNZQ4A9B8C7D6E5F4G3H2J1K',
          checkedEvidenceArtifacts: [callerArtifact],
          requestedOperation: 'reconcile',
        },
      },
    });

    expect(ingestion).toMatchObject({
      request: {
        householdId: message.householdId,
        checkedSourceArtifact: resolvedArtifact,
      },
    });
    expect(reconciliation).toMatchObject({
      request: {
        householdId: message.householdId,
        bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        checkedEvidenceArtifacts: [resolvedArtifact],
      },
    });
  });
});

describe('normalizeAccountingLeadRequest', () => {
  it('parses and materializes an add-bank-account delegate into a chart work result path', async () => {
    const query = vi.fn(async () => ({
      rows: [{ book_id: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' }],
    }));
    const delegate = {
      schemaName: 'accounting-lead-request',
      schemaVersion: 1,
      intent: 'chart_of_accounts',
      request: {
        schemaName: 'chart-work-request-draft',
        schemaVersion: 1,
        action: 'create_account',
        instruction: 'Add a bank account.',
        known: {},
      },
    };
    expect(parseDelegateTeamToolInput({ team: 'accounting', request: delegate }).request).toMatchObject(delegate);
    const normalized = await normalizeAccountingLeadRequest({ accounting: { query } } as never, message, delegate);
    const request = ChartWorkRequestSchemaV1.parse((normalized as { request: unknown }).request);
    const modelGenerate = vi.fn(async () => {
      throw new Error('model should not be called');
    });
    const maker = createChartMakerAgent({
      models: {
        lead: { id: 'provider/lead', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
        maker: { id: 'provider/maker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
        checker: { id: 'provider/checker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      },
      tools: {},
      agentFactory: () => ({ generate: modelGenerate } as never),
    });
    const skill = accountingSkills.find((candidate) => candidate.identity.skillName === 'chart-of-accounts')!;
    const invocation = MakerInvocationSchemaV1.parse({
      schemaName: 'maker-invocation',
      schemaVersion: 1,
      householdId: message.householdId,
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      team: 'accounting',
      role: { roleName: 'chart-maker', roleVersion: 1 },
      skill: skill.identity,
      inputSchema: { schemaName: 'chart-work-request', schemaVersion: 1 },
      outputSchema: { schemaName: 'chart-work-result', schemaVersion: 1 },
      input: request,
      permittedEvidence: [],
      policyLabels: ['personalized_finance'],
      stopCondition: { code: 'checked-chart-change', description: 'Return one checked chart result.' },
    });
    const submission = captureContractSubmission();

    await maker.generate(
      [{ role: 'user', content: JSON.stringify(invocation) }],
      submission.options as never,
    );

    expect(request.accountId).toMatch(/^account_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(modelGenerate).not.toHaveBeenCalled();
    const artifact = MakerArtifactSchemaV1.parse(submission.submitted());
    expect(ChartWorkResultSchemaV1.parse(artifact.output)).toMatchObject({
      schemaName: 'chart-clarification',
      missingFields: ['name', 'accounting_class', 'native_currency'],
    });
  });

  it('materializes an asset chart create draft with a debit normal-balance default', async () => {
    const query = vi.fn(async (text: string) => text.includes('FROM accounting.books')
      ? { rows: [{ book_id: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' }] }
      : { rows: [] });
    const pools = { accounting: { query } } as never;

    const normalized = await normalizeAccountingLeadRequest(pools, message, {
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
          nativeCurrency: 'USD',
        },
      },
    });
    const parsed = ChartWorkRequestSchemaV1.parse((normalized as { request: unknown }).request);

    expect(parsed).toMatchObject({
      schemaName: 'chart-work-request',
      schemaVersion: 1,
      action: 'create_account',
      householdId: message.householdId,
      bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      instruction: 'Add a checking account.',
      known: {
        name: 'Checking',
        accountingClass: 'asset',
        normalBalance: 'debit',
        nativeCurrency: 'USD',
      },
    });
    expect(parsed.accountId).toMatch(/^account_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(parsed).not.toHaveProperty('mappingId');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('canonicalizes typed transaction capture drafts without parsing prose', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ book_id: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' }] })
      .mockResolvedValueOnce({ rows: [{
        account_id: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
        native_currency: 'USD',
        accounting_class: 'asset',
      }] })
      .mockResolvedValueOnce({ rows: [{
        account_id: 'account_01JNZQ4A9B8C7D6E5F4G3H2J3K',
        native_currency: 'USD',
        accounting_class: 'expense',
      }] })
      .mockResolvedValueOnce({ rows: [{ matches: true }] })
      .mockResolvedValueOnce({ rows: [{ period_id: 'period_01JNZQ4A9B8C7D6E5F4G3H2J4K' }] });
    const pools = {
      accounting: {
        query,
      },
    } as never;

    const normalized = await normalizeAccountingLeadRequest(pools, message, {
      schemaName: 'accounting-lead-request',
      schemaVersion: 1,
      intent: 'transaction_capture',
      request: {
        schemaName: 'transaction-capture-request-draft',
        schemaVersion: 1,
        instruction: 'Record a USD 10.00 burger purchase from checking on 2026-06-27 in dining out.',
        known: {
          amount: '10.00',
          currency: 'USD',
          occurredOn: '2026-06-27',
          paymentAccountName: 'checking',
          categoryName: 'dining out',
        },
      },
    });

    expect(normalized).toMatchObject({
      schemaName: 'accounting-lead-request',
      schemaVersion: 1,
      intent: 'transaction_capture',
      request: {
        schemaName: 'transaction-capture-request',
        schemaVersion: 1,
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        periodId: 'period_01JNZQ4A9B8C7D6E5F4G3H2J4K',
        explicitInstruction: true,
        instruction: 'Record a USD 10.00 burger purchase from checking on 2026-06-27 in dining out.',
        paymentAccountCurrency: 'USD',
        paymentAccountClass: 'asset',
        categoryAccountCurrency: 'USD',
        categoryAccountClass: 'expense',
        known: {
          amount: '10.00',
          currency: 'USD',
          paymentAccountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          occurredOn: '2026-06-27',
          categoryAccountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J3K',
        },
      },
    });
  });

  it('turns an impossible transaction date into an unresolved field before period lookup', async () => {
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes('FROM accounting.books')) {
        return { rows: [{ book_id: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' }] };
      }
      if (text.includes('FROM accounting.periods')) {
        throw new Error('period lookup must not receive an invalid date');
      }
      if (text.includes('amount_matches_currency_scale')) {
        return { rows: [{ matches: true }] };
      }
      if (text.includes('FROM accounting.accounts')) {
        const allowedClasses = values?.[3] as string[] | undefined;
        const category = allowedClasses?.includes('expense') === true;
        return {
          rows: [{
            account_id: category
              ? 'account_01JNZQ4A9B8C7D6E5F4G3H2J3K'
              : 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
            native_currency: 'USD',
            accounting_class: category ? 'expense' : 'asset',
          }],
        };
      }
      return { rows: [] };
    });

    const normalized = await normalizeAccountingLeadRequest(
      { accounting: { query } } as never,
      message,
      {
        schemaName: 'accounting-lead-request',
        schemaVersion: 1,
        intent: 'transaction_capture',
        request: {
          schemaName: 'transaction-capture-request-draft',
          schemaVersion: 1,
          instruction: 'Record a purchase on 2026-02-30.',
          known: {
            amount: '25',
            currency: 'USD',
            occurredOn: '2026-02-30',
            paymentAccountName: 'Checking',
            categoryName: 'Groceries',
          },
        },
      },
    );

    expect(normalized).toMatchObject({
      request: {
        known: {
          amount: '25',
          currency: 'USD',
          paymentAccountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          categoryAccountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J3K',
        },
      },
    });
    expect(normalized).not.toHaveProperty('request.known.occurredOn');
    expect(query.mock.calls.some(([text]) => String(text).includes('FROM accounting.periods'))).toBe(false);
  });

  it('turns a non-positive transaction amount into an unresolved field', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ book_id: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' }] })
      .mockResolvedValueOnce({ rows: [{
        account_id: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
        native_currency: 'USD',
        accounting_class: 'asset',
      }] })
      .mockResolvedValueOnce({ rows: [{
        account_id: 'account_01JNZQ4A9B8C7D6E5F4G3H2J3K',
        native_currency: 'USD',
        accounting_class: 'expense',
      }] })
      .mockResolvedValueOnce({ rows: [{ period_id: 'period_01JNZQ4A9B8C7D6E5F4G3H2J4K' }] });

    const normalized = await normalizeAccountingLeadRequest(
      { accounting: { query } } as never,
      message,
      {
        schemaName: 'accounting-lead-request',
        schemaVersion: 1,
        intent: 'transaction_capture',
        request: {
          schemaName: 'transaction-capture-request-draft',
          schemaVersion: 1,
          instruction: 'Record a zero-value purchase.',
          known: {
            amount: '0',
            currency: 'USD',
            occurredOn: '2026-07-28',
            paymentAccountName: 'Checking',
            categoryName: 'Groceries',
          },
        },
      },
    );

    expect(normalized).toMatchObject({
      request: {
        known: {
          currency: 'USD',
          paymentAccountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          occurredOn: '2026-07-28',
          categoryAccountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J3K',
        },
      },
    });
    expect(normalized).not.toHaveProperty('request.known.amount');
  });

  it('turns an amount that violates its currency scale into an unresolved field', async () => {
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes('FROM accounting.books')) {
        return { rows: [{ book_id: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' }] };
      }
      if (text.includes('amount_matches_currency_scale')) {
        return { rows: [{ matches: false }] };
      }
      if (text.includes('FROM accounting.periods')) {
        return { rows: [{ period_id: 'period_01JNZQ4A9B8C7D6E5F4G3H2J4K' }] };
      }
      if (text.includes('FROM accounting.accounts')) {
        const allowedClasses = values?.[3] as string[] | undefined;
        const category = allowedClasses?.includes('expense') === true;
        return {
          rows: [{
            account_id: category
              ? 'account_01JNZQ4A9B8C7D6E5F4G3H2J3K'
              : 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
            native_currency: 'JPY',
            accounting_class: category ? 'expense' : 'asset',
          }],
        };
      }
      return { rows: [] };
    });

    const normalized = await normalizeAccountingLeadRequest(
      { accounting: { query } } as never,
      message,
      {
        schemaName: 'accounting-lead-request',
        schemaVersion: 1,
        intent: 'transaction_capture',
        request: {
          schemaName: 'transaction-capture-request-draft',
          schemaVersion: 1,
          instruction: 'Record fractional yen.',
          known: {
            amount: '10.5',
            currency: 'JPY',
            occurredOn: '2026-07-28',
            paymentAccountName: 'Main Wallet',
            categoryName: 'Snacks',
          },
        },
      },
    );

    expect(normalized).not.toHaveProperty('request.known.amount');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('amount_matches_currency_scale'),
      ['10.5', 'JPY'],
    );
  });

  it('preserves an unresolved category name and returns existing spending categories as suggestions', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ book_id: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' }] })
      .mockResolvedValueOnce({ rows: [{
        account_id: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
        native_currency: 'USD',
        accounting_class: 'asset',
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [
        { name: 'Food' },
        { name: 'Groceries' },
      ] })
      .mockResolvedValueOnce({ rows: [{ matches: true }] })
      .mockResolvedValueOnce({ rows: [{ period_id: 'period_01JNZQ4A9B8C7D6E5F4G3H2J4K' }] });

    const normalized = await normalizeAccountingLeadRequest({ accounting: { query } } as never, message, {
      schemaName: 'accounting-lead-request',
      schemaVersion: 1,
      intent: 'transaction_capture',
      request: {
        schemaName: 'transaction-capture-request-draft',
        schemaVersion: 1,
        instruction: 'Record a USD 50 purchase from test wallet yesterday in dining.',
        known: {
          amount: '50.00',
          currency: 'USD',
          occurredOn: '2026-07-15',
          paymentAccountName: 'test wallet',
          categoryName: 'dining',
        },
      },
    });

    expect(normalized).toMatchObject({
      request: {
        categoryName: 'dining',
        categoryCandidates: ['Food', 'Groceries'],
        known: {
          amount: '50.00',
          currency: 'USD',
          paymentAccountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          occurredOn: '2026-07-15',
        },
      },
    });
    expect(normalized).not.toHaveProperty('request.known.categoryAccountId');
  });

  it('rejects undeclared transaction input instead of deriving work from message text', async () => {
    const pools = {
      accounting: {
        query: vi.fn(async () => ({ rows: [{ book_id: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' }] })),
      },
    } as never;

    const request = {
      schemaName: 'accounting-lead-request',
      schemaVersion: 1,
      intent: 'transaction_capture',
      request: {},
    };
    await expect(normalizeAccountingLeadRequest(pools, message, request)).rejects.toThrow();
  });

  it('canonicalizes typed journal drafts by resolving the household book id', async () => {
    const pools = {
      accounting: {
        query: vi.fn(async () => ({ rows: [{ book_id: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' }] })),
      },
    } as never;

    const normalized = await normalizeAccountingLeadRequest(pools, message, {
      schemaName: 'accounting-lead-request',
      schemaVersion: 1,
      intent: 'journal',
      request: {
        schemaName: 'journal-work-request-draft',
        schemaVersion: 1,
        operation: 'transfer',
        instruction: 'transfer $1000 from my savings to my checking account',
      },
    });

    expect(normalized).toMatchObject({
      schemaName: 'accounting-lead-request',
      schemaVersion: 1,
      intent: 'journal',
      request: {
        schemaName: 'journal-work-request',
        schemaVersion: 1,
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        operation: 'transfer',
        instruction: 'transfer $1000 from my savings to my checking account',
      },
    });
  });
});

describe('normalizeQueryLeadRequest', () => {
  it('canonicalizes a typed query draft from reporting metadata instead of model-supplied grain', async () => {
    const { pools, query } = queryPools({
      'reporting.categorized_transactions': ['household', 'posting'],
    });
    const normalized = await normalizeQueryLeadRequest(pools, message, queryDraft('List our transactions.', {
      desiredGrain: ['transaction', 'category'],
      coverage: ['categorized transactions'],
    }));

    const parsed = EvidenceRequestSchemaV1.parse(normalized);
    expect(parsed).toMatchObject({
      schemaName: 'evidence-request',
      schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      businessQuestion: 'List our transactions.',
      intendedUse: 'household_finance_answer',
      timeframe: { start: '2026-06-24', end: '2026-06-24' },
      desiredGrain: ['household', 'posting'],
      filters: [],
      requiredFreshness: 'latest available reporting projection',
      requiredCalculations: [],
      coverage: ['categorized transactions'],
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('reporting.relation_metadata'), [
      'reporting.categorized_transactions',
    ]);
    expect(parsed.requestId).toMatch(/^evidence_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('canonicalizes a typed account-list query draft from reporting metadata', async () => {
    const { pools } = queryPools({ 'reporting.accounts': ['household', 'account'] });
    const normalized = await normalizeQueryLeadRequest(pools, message, queryDraft('List our accounts.', {
      desiredGrain: ['account'],
      coverage: ['account list'],
    }));

    const parsed = EvidenceRequestSchemaV1.parse(normalized);
    expect(parsed).toMatchObject({
      schemaName: 'evidence-request',
      schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      businessQuestion: 'List our accounts.',
      intendedUse: 'household_finance_answer',
      timeframe: { start: '2026-06-24', end: '2026-06-24' },
      desiredGrain: ['household', 'account'],
      filters: [],
      requiredFreshness: 'latest available reporting projection',
      requiredCalculations: [],
      coverage: ['account list'],
    });
    expect(parsed.requestId).toMatch(/^evidence_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('uses generic coverage for legacy thin query objects instead of keyword regex', async () => {
    const { pools, query } = queryPools({});
    const normalized = await normalizeQueryLeadRequest(pools, message, {
      businessQuestion: 'What are our balances?',
    });

    const parsed = EvidenceRequestSchemaV1.parse(normalized);
    expect(parsed).toMatchObject({
      businessQuestion: 'What are our balances?',
      desiredGrain: ['household'],
      requiredCalculations: [],
      coverage: ['requested household finance answer'],
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('canonicalizes a full EvidenceRequestV1 when its model grain conflicts with reporting metadata', async () => {
    const { pools } = queryPools({
      'reporting.categorized_transactions': ['household', 'posting'],
    });
    const request = EvidenceRequestSchemaV1.parse({
      schemaName: 'evidence-request',
      schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J2K',
      requestId: 'evidence_01JZZZZZZZZZZZZZZZZZZZZZZZ',
      businessQuestion: 'List our transactions.',
      intendedUse: 'household_finance_answer',
      timeframe: { start: '2026-06-01', end: '2026-06-24' },
      desiredGrain: ['transaction', 'category'],
      filters: [],
      requiredFreshness: 'latest available reporting projection',
      requiredCalculations: [],
      coverage: ['categorized transactions'],
    });

    await expect(normalizeQueryLeadRequest(pools, message, request)).resolves.toEqual({
      ...request,
      householdId: message.householdId,
      desiredGrain: ['household', 'posting'],
    });
  });
});

describe('makerInputForLeadWorkItem', () => {
  it('uses the normalized Query request as query-evidence maker input, but leaves query-analyst maker input unchanged', async () => {
    const { pools } = queryPools({ 'reporting.accounts': ['household', 'account'] });
    const normalized = await normalizeQueryLeadRequest(pools, message, queryDraft('List our accounts.', {
      desiredGrain: ['household', 'account'],
      coverage: ['account list'],
    }));
    const analystInput = {
      schemaName: 'analyst-task',
      schemaVersion: 1,
      evidencePackageId: 'evidence_01JZZZZZZZZZZZZZZZZZZZZZZZ',
      request: normalized,
      queryResult: {
        schemaName: 'query-result',
        schemaVersion: 1,
        relationName: 'reporting.account_balances',
        grain: ['account'],
        rows: [],
        fieldDefinitions: ['account_name'],
        sourceReferences: ['reporting.account_balances'],
        freshness: 'latest available reporting projection',
        coverageWarnings: [],
      },
    };

    expect(makerInputForLeadWorkItem(queryTeamDefinition, 'query-evidence', { original: true }, normalized))
      .toEqual(normalized);
    const conflictingPlanRequest = EvidenceRequestSchemaV1.parse({
      schemaName: 'evidence-request',
      schemaVersion: 1,
      householdId: message.householdId,
      requestId: 'evidence_01JZZZZZZZZZZZZZZZZZZZZZZZ',
      businessQuestion: 'List our accounts.',
      intendedUse: 'household_finance_answer',
      timeframe: { start: '2026-06-01', end: '2026-06-24' },
      desiredGrain: ['category'],
      filters: [],
      requiredFreshness: 'latest available reporting projection',
      requiredCalculations: [],
      coverage: ['account list'],
    });
    expect(makerInputForLeadWorkItem(queryTeamDefinition, 'query-evidence', conflictingPlanRequest, normalized))
      .toEqual(normalized);
    expect(makerInputForLeadWorkItem(queryTeamDefinition, 'query-analyst', analystInput, normalized))
      .toEqual(analystInput);
  });
});

describe('deterministicLeadPlanForRequest', () => {
  it('builds the one valid Query lead plan for the normalized account-list slice', async () => {
    const { pools } = queryPools({ 'reporting.accounts': ['household', 'account'] });
    const request = await normalizeQueryLeadRequest(pools, message, queryDraft('List our accounts.', {
      desiredGrain: ['household', 'account'],
      coverage: ['account list'],
    }));

    expect(deterministicLeadPlanForRequest(queryTeamDefinition, request)).toEqual({
      schemaName: 'team-lead-plan',
      schemaVersion: 1,
      recommendedStrategyName: 'single-maker-checker',
      work: [{ workCellId: 'query-evidence', makerInput: request }],
      stopCondition: { code: 'query-answer', description: 'Return one checked query answer.' },
    });
  });

  it('builds the same deterministic Query plan for a normalized balances slice', async () => {
    const { pools } = queryPools({});
    const request = await normalizeQueryLeadRequest(pools, message, {
      businessQuestion: 'What are our balances?',
    });

    expect(deterministicLeadPlanForRequest(queryTeamDefinition, request)).toBeUndefined();
  });

  it('leaves calculation requests with known coverage on the modeled team-lead path', () => {
    const request = EvidenceRequestSchemaV1.parse({
      schemaName: 'evidence-request',
      schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      requestId: 'evidence_01JZZZZZZZZZZZZZZZZZZZZZZZ',
      businessQuestion: 'What is our average balance this month?',
      intendedUse: 'household_finance_answer',
      timeframe: { start: '2026-06-01', end: '2026-06-24' },
      desiredGrain: ['household', 'account'],
      filters: [],
      requiredFreshness: 'latest available reporting projection',
      requiredCalculations: ['average balance by account'],
      coverage: ['balance snapshot'],
    });

    expect(deterministicLeadPlanForRequest(queryTeamDefinition, request)).toBeUndefined();
  });

  it('leaves calculation-heavy Query requests on the modeled team-lead path', () => {
    const request = EvidenceRequestSchemaV1.parse({
      schemaName: 'evidence-request',
      schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      requestId: 'evidence_01JZZZZZZZZZZZZZZZZZZZZZZZ',
      businessQuestion: 'What are my top expenses this month?',
      intendedUse: 'expense_tracking',
      timeframe: { start: '2026-06-01', end: '2026-06-30' },
      desiredGrain: ['category'],
      filters: [],
      requiredFreshness: 'latest',
      requiredCalculations: ['sum'],
      coverage: ['all'],
    });

    expect(deterministicLeadPlanForRequest(queryTeamDefinition, request)).toBeUndefined();
  });

  it('uses deterministic Query evidence for explicit category spend coverage', () => {
    const request = EvidenceRequestSchemaV1.parse({
      schemaName: 'evidence-request',
      schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      requestId: 'evidence_01JZZZZZZZZZZZZZZZZZZZZZZZ',
      businessQuestion: 'What are my top expenses this month?',
      intendedUse: 'expense_tracking',
      timeframe: { start: '2026-06-01', end: '2026-06-30' },
      desiredGrain: ['household', 'month', 'category'],
      filters: [],
      requiredFreshness: 'latest',
      requiredCalculations: [],
      coverage: ['category spend monthly'],
    });

    expect(deterministicLeadPlanForRequest(queryTeamDefinition, request)).toEqual({
      schemaName: 'team-lead-plan',
      schemaVersion: 1,
      recommendedStrategyName: 'single-maker-checker',
      work: [{ workCellId: 'query-evidence', makerInput: request }],
      stopCondition: { code: 'query-answer', description: 'Return one checked query answer.' },
    });
  });

  it('uses deterministic Accounting routing for typed accounting requests', () => {
    const request = {
      schemaName: 'accounting-lead-request',
      schemaVersion: 1,
      intent: 'transaction_capture',
      request: {
        schemaName: 'transaction-capture-request',
        schemaVersion: 1,
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        explicitInstruction: true,
        instruction: 'add $10 of buying a burger',
        known: { amount: '10.00', currency: 'USD' },
      },
    };

    expect(deterministicLeadPlanForRequest(accountingTeamDefinition, request)).toEqual({
      schemaName: 'team-lead-plan',
      schemaVersion: 1,
      recommendedStrategyName: 'single-maker-checker',
      work: [{ workCellId: 'transaction-capture', makerInput: request.request }],
      stopCondition: {
        code: 'checked-transaction-capture',
        description: 'Return one checked accounting result.',
      },
    });
  });

  it('routes chart-of-accounts requests deterministically', () => {
    const request = {
      schemaName: 'accounting-lead-request',
      schemaVersion: 1,
      intent: 'chart_of_accounts',
      request: {
        schemaName: 'chart-work-request-draft',
        schemaVersion: 1,
        action: 'create_account',
        instruction: 'Add a bank account.',
        known: {},
      },
    };

    expect(deterministicLeadPlanForRequest(accountingTeamDefinition, request)).toMatchObject({
      recommendedStrategyName: 'single-maker-checker',
      work: [{ workCellId: 'chart-of-accounts', makerInput: request.request }],
      stopCondition: { code: 'checked-chart-change' },
    });
  });
});
