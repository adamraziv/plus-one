import type { DatabasePools } from '@plus-one/database';
import {
  ChartWorkRequestSchemaV1,
  JournalWorkRequestSchemaV1,
  TransactionCaptureRequestSchemaV1,
  type ChartWorkRequestV1,
  type TransactionCaptureRequestV1,
} from '@plus-one/accounting';
import {
  ImportBatchIdSchema,
  IngestionWorkRequestSchemaV1,
  ReconciliationWorkRequestSchemaV1,
  StatementSnapshotIdSchema,
} from '@plus-one/ingestion';
import {
  AccountIdSchema,
  AccountSourceMappingIdSchema,
  ArtifactHashSchema,
  ArtifactIdSchema,
  BookIdSchema,
  CurrencyCodeSchema,
  PeriodIdSchema,
  PlusOneError,
  TaskIdSchema,
  type AccountId,
  type AccountSourceMappingId,
  type ArtifactEnvelopeV1,
  type CurrencyCode,
  type InboundChannelMessageV1,
  type PeriodId,
  type TaskId,
} from '@plus-one/contracts';
import { ArtifactStore } from '@plus-one/runtime';
import {
  AccountingDelegateRequestSchemaV1,
  MaterializedAccountingLeadRequestSchemaV1,
  type AccountingDelegateRequestV1,
  type MaterializedAccountingLeadRequestV1,
} from './accounting-lead-contracts.js';
import {
  ChartWorkRequestDraftSchemaV1,
  IngestionWorkRequestDraftSchemaV1,
  JournalWorkRequestDraftSchemaV1,
  ReconciliationWorkRequestDraftSchemaV1,
  TransactionCaptureRequestDraftSchemaV1,
  type ChartWorkRequestDraftV1,
  type TransactionCaptureRequestDraftV1,
} from './accounting-request-drafts.js';

type AccountingIntent = AccountingDelegateRequestV1['intent'];
type DelegateRequestFor<I extends AccountingIntent> = Extract<AccountingDelegateRequestV1, { intent: I }>;
type MaterializedRequestFor<I extends AccountingIntent> = Extract<
  MaterializedAccountingLeadRequestV1,
  { intent: I }
>;

export interface AccountingMaterializationContext {
  pools: DatabasePools;
  artifacts: ArtifactStore;
  message: InboundChannelMessageV1;
  allocateAccountId: () => AccountId;
  allocateAccountMappingId: () => AccountSourceMappingId;
}

interface AccountingRequestMaterializer<I extends AccountingIntent> {
  materialize(input: AccountingMaterializationContext & {
    request: DelegateRequestFor<I>['request'];
  }): Promise<MaterializedRequestFor<I>['request']>;
}

export async function materializeAccountingLeadRequest(input: AccountingMaterializationContext & {
  request: unknown;
}): Promise<MaterializedAccountingLeadRequestV1> {
  const parsed = AccountingDelegateRequestSchemaV1.parse(input.request);
  const context: AccountingMaterializationContext = {
    pools: input.pools,
    artifacts: input.artifacts,
    message: input.message,
    allocateAccountId: input.allocateAccountId,
    allocateAccountMappingId: input.allocateAccountMappingId,
  };

  switch (parsed.intent) {
    case 'transaction_capture':
      return MaterializedAccountingLeadRequestSchemaV1.parse({
        ...parsed,
        request: await accountingRequestMaterializers.transaction_capture.materialize({
          ...context,
          request: parsed.request,
        }),
      });
    case 'ingestion':
      return MaterializedAccountingLeadRequestSchemaV1.parse({
        ...parsed,
        request: await accountingRequestMaterializers.ingestion.materialize({
          ...context,
          request: parsed.request,
        }),
      });
    case 'journal':
      return MaterializedAccountingLeadRequestSchemaV1.parse({
        ...parsed,
        request: await accountingRequestMaterializers.journal.materialize({
          ...context,
          request: parsed.request,
        }),
      });
    case 'chart_of_accounts':
      return MaterializedAccountingLeadRequestSchemaV1.parse({
        ...parsed,
        request: await accountingRequestMaterializers.chart_of_accounts.materialize({
          ...context,
          request: parsed.request,
        }),
      });
    case 'reconciliation':
      return MaterializedAccountingLeadRequestSchemaV1.parse({
        ...parsed,
        request: await accountingRequestMaterializers.reconciliation.materialize({
          ...context,
          request: parsed.request,
        }),
      });
  }
}

const transactionCaptureMaterializer: AccountingRequestMaterializer<'transaction_capture'> = {
  async materialize(input) {
    const bookId = await resolveHouseholdBookId(input.pools, input.message.householdId);
    const complete = TransactionCaptureRequestSchemaV1.safeParse(input.request);

    if (complete.success) {
      return materializeCompleteTransactionCapture(input, bookId, complete.data);
    }

    const draft = TransactionCaptureRequestDraftSchemaV1.parse(input.request);
    const resolvedKnown = await canonicalTransactionKnown(
      input.pools,
      input.message.householdId,
      bookId,
      draft.known,
    );
    const periodId = resolvedKnown.known.occurredOn === undefined
      ? undefined
      : await resolvePeriodIdForOccurredOn(
        input.pools,
        input.message.householdId,
        bookId,
        resolvedKnown.known.occurredOn,
      );

    return TransactionCaptureRequestSchemaV1.parse({
      schemaName: 'transaction-capture-request',
      schemaVersion: 1,
      householdId: input.message.householdId,
      bookId,
      ...(periodId === undefined ? {} : { periodId }),
      explicitInstruction: true,
      instruction: draft.instruction,
      ...(resolvedKnown.paymentAccountCurrency === undefined
        ? {}
        : { paymentAccountCurrency: resolvedKnown.paymentAccountCurrency }),
      ...(resolvedKnown.categoryAccountCurrency === undefined
        ? {}
        : { categoryAccountCurrency: resolvedKnown.categoryAccountCurrency }),
      known: resolvedKnown.known,
    });
  },
};

const journalMaterializer: AccountingRequestMaterializer<'journal'> = {
  async materialize(input) {
    const bookId = await resolveHouseholdBookId(input.pools, input.message.householdId);
    const complete = JournalWorkRequestSchemaV1.safeParse(input.request);
    const request = complete.success ? complete.data : JournalWorkRequestDraftSchemaV1.parse(input.request);

    return JournalWorkRequestSchemaV1.parse({
      schemaName: 'journal-work-request',
      schemaVersion: 1,
      householdId: input.message.householdId,
      bookId,
      operation: request.operation,
      instruction: request.instruction,
    });
  },
};

const chartMaterializer: AccountingRequestMaterializer<'chart_of_accounts'> = {
  async materialize(input) {
    const bookId = await resolveHouseholdBookId(input.pools, input.message.householdId);
    const complete = ChartWorkRequestSchemaV1.safeParse(input.request);

    if (complete.success) {
      return materializeCompleteChartRequest(input, bookId, complete.data);
    }

    return materializeChartDraft(input, bookId, ChartWorkRequestDraftSchemaV1.parse(input.request));
  },
};

const ingestionMaterializer: AccountingRequestMaterializer<'ingestion'> = {
  async materialize(input) {
    const complete = IngestionWorkRequestSchemaV1.safeParse(input.request);
    const batch = complete.success
      ? await resolveImportBatchById(input, complete.data.importBatchId)
      : await resolveImportBatchByReference(input, IngestionWorkRequestDraftSchemaV1.parse(input.request));
    const checkedSourceArtifact = await loadCheckedArtifact(input, batch.artifact);

    return IngestionWorkRequestSchemaV1.parse({
      schemaName: 'ingestion-work-request',
      schemaVersion: 1,
      householdId: input.message.householdId,
      importBatchId: batch.importBatchId,
      checkedSourceArtifact,
    });
  },
};

const reconciliationMaterializer: AccountingRequestMaterializer<'reconciliation'> = {
  async materialize(input) {
    const bookId = await resolveHouseholdBookId(input.pools, input.message.householdId);
    const complete = ReconciliationWorkRequestSchemaV1.safeParse(input.request);
    const resolved = complete.success
      ? await resolveSnapshotById(input, bookId, complete.data.accountId, complete.data.statementSnapshotId)
      : await resolveSnapshotByReference(input, bookId, ReconciliationWorkRequestDraftSchemaV1.parse(input.request));
    const checkedEvidenceArtifacts = await Promise.all(
      resolved.artifacts.map(async (artifact) => loadCheckedArtifact(input, artifact)),
    );

    return ReconciliationWorkRequestSchemaV1.parse({
      schemaName: 'reconciliation-work-request',
      schemaVersion: 1,
      householdId: input.message.householdId,
      bookId,
      accountId: resolved.accountId,
      statementSnapshotId: resolved.statementSnapshotId,
      checkedEvidenceArtifacts,
      requestedOperation: complete.success
        ? complete.data.requestedOperation
        : ReconciliationWorkRequestDraftSchemaV1.parse(input.request).requestedOperation,
    });
  },
};

export const accountingRequestMaterializers = {
  transaction_capture: transactionCaptureMaterializer,
  ingestion: ingestionMaterializer,
  journal: journalMaterializer,
  chart_of_accounts: chartMaterializer,
  reconciliation: reconciliationMaterializer,
} satisfies { [I in AccountingIntent]: AccountingRequestMaterializer<I> };

async function materializeCompleteTransactionCapture(
  input: AccountingMaterializationContext,
  bookId: ReturnType<typeof BookIdSchema.parse>,
  request: TransactionCaptureRequestV1,
) {
  const paymentAccount = request.known.paymentAccountId === undefined
    ? undefined
    : await requireScopedAccountById(
      input.pools,
      input.message.householdId,
      bookId,
      request.known.paymentAccountId,
      paymentAccountingClasses,
      'transaction_payment_account_out_of_scope',
    );
  const categoryAccount = request.known.categoryAccountId === undefined
    ? undefined
    : await requireScopedAccountById(
      input.pools,
      input.message.householdId,
      bookId,
      request.known.categoryAccountId,
      categoryAccountingClasses,
      'transaction_category_account_out_of_scope',
    );
  const periodId = request.periodId === undefined
    ? request.known.occurredOn === undefined
      ? undefined
      : await resolvePeriodIdForOccurredOn(
        input.pools,
        input.message.householdId,
        bookId,
        request.known.occurredOn,
      )
    : await requireScopedPeriodId(
      input.pools,
      input.message.householdId,
      bookId,
      request.periodId,
    );

  return TransactionCaptureRequestSchemaV1.parse({
    ...request,
    householdId: input.message.householdId,
    bookId,
    ...(periodId === undefined ? {} : { periodId }),
    ...(paymentAccount === undefined ? {} : { paymentAccountCurrency: paymentAccount.nativeCurrency }),
    ...(categoryAccount === undefined ? {} : { categoryAccountCurrency: categoryAccount.nativeCurrency }),
  });
}

async function materializeChartDraft(
  input: AccountingMaterializationContext,
  bookId: ReturnType<typeof BookIdSchema.parse>,
  draft: ChartWorkRequestDraftV1,
) {
  const base = {
    schemaName: 'chart-work-request' as const,
    schemaVersion: 1 as const,
    householdId: input.message.householdId,
    bookId,
    instruction: draft.instruction,
    known: await chartKnownFromDraft(input.pools, input.message.householdId, bookId, draft),
  };

  switch (draft.action) {
    case 'create_account':
      return ChartWorkRequestSchemaV1.parse({
        ...base,
        action: draft.action,
        accountId: input.allocateAccountId(),
      });
    case 'update_account':
    case 'archive_account':
      return ChartWorkRequestSchemaV1.parse({
        ...base,
        action: draft.action,
        accountId: await requireScopedAccountByName(
          input.pools,
          input.message.householdId,
          bookId,
          draft.known.accountName,
          'chart_target_account',
        ),
      });
    case 'create_source_mapping':
      return ChartWorkRequestSchemaV1.parse({
        ...base,
        action: draft.action,
        mappingId: input.allocateAccountMappingId(),
        accountId: await requireScopedAccountByName(
          input.pools,
          input.message.householdId,
          bookId,
          draft.known.accountName,
          'chart_target_account',
        ),
      });
    case 'replace_source_mapping':
      return ChartWorkRequestSchemaV1.parse({
        ...base,
        action: draft.action,
        mappingId: input.allocateAccountMappingId(),
        archivedMappingId: await requireScopedMappingByReference(
          input.pools,
          input.message.householdId,
          bookId,
          draft.known.sourceSystem,
          draft.known.externalAccountId,
        ),
        accountId: await requireScopedAccountByName(
          input.pools,
          input.message.householdId,
          bookId,
          draft.known.accountName,
          'chart_target_account',
        ),
      });
  }
}

async function materializeCompleteChartRequest(
  input: AccountingMaterializationContext,
  bookId: ReturnType<typeof BookIdSchema.parse>,
  request: ChartWorkRequestV1,
) {
  const base = {
    schemaName: 'chart-work-request' as const,
    schemaVersion: 1 as const,
    householdId: input.message.householdId,
    bookId,
    instruction: request.instruction,
    known: await scopeChartKnown(input.pools, input.message.householdId, bookId, request.known),
  };

  switch (request.action) {
    case 'create_account':
      return ChartWorkRequestSchemaV1.parse({
        ...base,
        action: request.action,
        accountId: input.allocateAccountId(),
      });
    case 'update_account':
    case 'archive_account':
      return ChartWorkRequestSchemaV1.parse({
        ...base,
        action: request.action,
        accountId: (await requireScopedAccountById(
          input.pools,
          input.message.householdId,
          bookId,
          request.accountId,
          undefined,
          'chart_target_account_out_of_scope',
        )).accountId,
      });
    case 'create_source_mapping':
      return ChartWorkRequestSchemaV1.parse({
        ...base,
        action: request.action,
        mappingId: input.allocateAccountMappingId(),
        accountId: (await requireScopedAccountById(
          input.pools,
          input.message.householdId,
          bookId,
          request.accountId,
          undefined,
          'chart_target_account_out_of_scope',
        )).accountId,
      });
    case 'replace_source_mapping':
      return ChartWorkRequestSchemaV1.parse({
        ...base,
        action: request.action,
        mappingId: input.allocateAccountMappingId(),
        archivedMappingId: await requireScopedMappingById(
          input.pools,
          input.message.householdId,
          bookId,
          request.archivedMappingId,
        ),
        accountId: (await requireScopedAccountById(
          input.pools,
          input.message.householdId,
          bookId,
          request.accountId,
          undefined,
          'chart_target_account_out_of_scope',
        )).accountId,
      });
  }
}

async function chartKnownFromDraft(
  pools: DatabasePools,
  householdId: string,
  bookId: ReturnType<typeof BookIdSchema.parse>,
  draft: ChartWorkRequestDraftV1,
) {
  const parentAccountId = draft.known.parentAccountName === undefined
    ? undefined
    : await resolveScopedAccountByName(pools, householdId, bookId, draft.known.parentAccountName);
  const normalBalance = draft.known.normalBalance
    ?? defaultNormalBalance(draft.known.accountingClass);
  return {
    ...(parentAccountId === undefined ? {} : { parentAccountId }),
    ...(draft.known.accountName === undefined ? {} : { name: draft.known.accountName }),
    ...(draft.known.purpose === undefined ? {} : { purpose: draft.known.purpose }),
    ...(draft.known.accountingClass === undefined ? {} : { accountingClass: draft.known.accountingClass }),
    ...(normalBalance === undefined ? {} : { normalBalance }),
    ...(draft.known.nativeCurrency === undefined ? {} : { nativeCurrency: draft.known.nativeCurrency }),
    ...(draft.known.ownershipLabel === undefined ? {} : { ownershipLabel: draft.known.ownershipLabel }),
    ...(draft.known.sourceSystem === undefined ? {} : { sourceSystem: draft.known.sourceSystem }),
    ...(draft.known.externalAccountId === undefined ? {} : { externalAccountId: draft.known.externalAccountId }),
  };
}

function defaultNormalBalance(accountingClass: ChartWorkRequestDraftV1['known']['accountingClass']) {
  if (accountingClass === undefined) return undefined;
  return accountingClass === 'asset' || accountingClass === 'expense' ? 'debit' as const : 'credit' as const;
}

async function scopeChartKnown(
  pools: DatabasePools,
  householdId: string,
  bookId: ReturnType<typeof BookIdSchema.parse>,
  known: ChartWorkRequestV1['known'],
) {
  const parentAccountId = known.parentAccountId === undefined
    ? undefined
    : (await requireScopedAccountById(
      pools,
      householdId,
      bookId,
      known.parentAccountId,
      undefined,
      'chart_parent_account_out_of_scope',
    )).accountId;
  return {
    ...known,
    ...(parentAccountId === undefined ? {} : { parentAccountId }),
  };
}

async function resolveHouseholdBookId(
  pools: DatabasePools,
  householdId: string,
): Promise<ReturnType<typeof BookIdSchema.parse>> {
  const result = await pools.accounting.query<{ book_id: string }>(
    `SELECT book.book_id
     FROM accounting.books book
     JOIN operations.households household ON household.id = book.household_id
     WHERE household.household_id = $1
     ORDER BY book.book_id
     LIMIT 2`,
    [householdId],
  );
  if (result.rows.length === 1) return BookIdSchema.parse(result.rows[0]!.book_id);
  throw materializationError(
    'validation_rejected',
    'household_book_not_found',
    'Accounting requests require exactly one household book',
    { matchedBooks: result.rows.length },
  );
}

async function canonicalTransactionKnown(
  pools: DatabasePools,
  householdId: string,
  bookId: ReturnType<typeof BookIdSchema.parse>,
  known: TransactionCaptureRequestDraftV1['known'],
): Promise<{
  known: TransactionCaptureRequestV1['known'];
  paymentAccountCurrency?: CurrencyCode;
  categoryAccountCurrency?: CurrencyCode;
}> {
  const paymentAccount = known.paymentAccountName === undefined
    ? undefined
    : await findScopedAccountByName(
      pools,
      householdId,
      bookId,
      known.paymentAccountName,
      paymentAccountingClasses,
    );
  const categoryAccount = known.categoryName === undefined
    ? undefined
    : await findScopedAccountByName(
      pools,
      householdId,
      bookId,
      known.categoryName,
      categoryAccountingClasses,
    );
  return {
    known: {
      ...(known.amount === undefined ? {} : { amount: known.amount }),
      ...(known.currency === undefined ? {} : { currency: known.currency }),
      ...(paymentAccount === undefined ? {} : { paymentAccountId: paymentAccount.accountId }),
      ...(known.occurredOn === undefined ? {} : { occurredOn: known.occurredOn }),
      ...(categoryAccount === undefined ? {} : { categoryAccountId: categoryAccount.accountId }),
    },
    ...(paymentAccount === undefined ? {} : { paymentAccountCurrency: paymentAccount.nativeCurrency }),
    ...(categoryAccount === undefined ? {} : { categoryAccountCurrency: categoryAccount.nativeCurrency }),
  };
}

const paymentAccountingClasses = ['asset', 'liability', 'equity'];
const categoryAccountingClasses = ['expense', 'income'];

async function findScopedAccountByName(
  pools: DatabasePools,
  householdId: string,
  bookId: ReturnType<typeof BookIdSchema.parse>,
  accountName: string,
  allowedClasses?: readonly string[],
): Promise<{ accountId: AccountId; nativeCurrency: CurrencyCode } | undefined> {
  const normalizedName = accountName.trim();
  if (normalizedName.length === 0) return undefined;
  const result = await pools.accounting.query<{ account_id: string; native_currency: string }>(
    `SELECT account.account_id, account.native_currency
     FROM accounting.accounts account
     JOIN operations.households household ON household.id = account.household_id
     JOIN accounting.books book ON book.id = account.book_id
     WHERE household.household_id = $1
       AND book.book_id = $2
       AND lower(account.name) = lower($3)
       AND ($4::text[] IS NULL OR account.accounting_class = ANY($4::text[]))
       AND account.archived_at IS NULL
     ORDER BY account.account_id
     LIMIT 2`,
    [householdId, bookId, normalizedName, allowedClasses === undefined ? null : [...allowedClasses]],
  );
  return result.rows.length === 1
    ? {
      accountId: AccountIdSchema.parse(result.rows[0]!.account_id),
      nativeCurrency: CurrencyCodeSchema.parse(result.rows[0]!.native_currency),
    }
    : undefined;
}

async function resolveScopedAccountByName(
  pools: DatabasePools,
  householdId: string,
  bookId: ReturnType<typeof BookIdSchema.parse>,
  accountName: string,
): Promise<AccountId | undefined> {
  return (await findScopedAccountByName(pools, householdId, bookId, accountName))?.accountId;
}

async function requireScopedAccountByName(
  pools: DatabasePools,
  householdId: string,
  bookId: ReturnType<typeof BookIdSchema.parse>,
  accountName: string | undefined,
  codePrefix: string,
): Promise<AccountId> {
  if (accountName === undefined || accountName.trim().length === 0) {
    throw materializationError(
      'validation_rejected',
      `${codePrefix}_missing`,
      'The requested account reference is required',
    );
  }
  const result = await pools.accounting.query<{ account_id: string }>(
    `SELECT account.account_id
     FROM accounting.accounts account
     JOIN operations.households household ON household.id = account.household_id
     JOIN accounting.books book ON book.id = account.book_id
     WHERE household.household_id = $1
       AND book.book_id = $2
       AND lower(account.name) = lower($3)
       AND account.archived_at IS NULL
     ORDER BY account.account_id
     LIMIT 2`,
    [householdId, bookId, accountName.trim()],
  );
  if (result.rows.length === 1) return AccountIdSchema.parse(result.rows[0]!.account_id);
  throw materializationError(
    result.rows.length === 0 ? 'validation_rejected' : 'ambiguous_source_match',
    `${codePrefix}_${result.rows.length === 0 ? 'missing' : 'ambiguous'}`,
    result.rows.length === 0
      ? 'The requested account was not found in this household book'
      : 'The requested account reference matches multiple household accounts',
  );
}

async function requireScopedAccountById(
  pools: DatabasePools,
  householdId: string,
  bookId: ReturnType<typeof BookIdSchema.parse>,
  accountId: AccountId,
  allowedClasses: readonly string[] | undefined,
  code: string,
): Promise<{ accountId: AccountId; nativeCurrency: CurrencyCode }> {
  const result = await pools.accounting.query<{ account_id: string; native_currency: string }>(
    `SELECT account.account_id, account.native_currency
     FROM accounting.accounts account
     JOIN operations.households household ON household.id = account.household_id
     JOIN accounting.books book ON book.id = account.book_id
     WHERE household.household_id = $1
       AND book.book_id = $2
       AND account.account_id = $3
       AND ($4::text[] IS NULL OR account.accounting_class = ANY($4::text[]))
       AND account.archived_at IS NULL
     LIMIT 2`,
    [householdId, bookId, accountId, allowedClasses === undefined ? null : [...allowedClasses]],
  );
  if (result.rows.length === 1) {
    return {
      accountId: AccountIdSchema.parse(result.rows[0]!.account_id),
      nativeCurrency: CurrencyCodeSchema.parse(result.rows[0]!.native_currency),
    };
  }
  throw materializationError(
    'validation_rejected',
    code,
    'The supplied account is outside the active household book scope',
  );
}

async function resolvePeriodIdForOccurredOn(
  pools: DatabasePools,
  householdId: string,
  bookId: ReturnType<typeof BookIdSchema.parse>,
  occurredOn: string,
): Promise<PeriodId | undefined> {
  const result = await pools.accounting.query<{ period_id: string }>(
    `SELECT period.period_id
     FROM accounting.periods period
     JOIN operations.households household ON household.id = period.household_id
     JOIN accounting.books book ON book.id = period.book_id
     WHERE household.household_id = $1
       AND book.book_id = $2
       AND $3::date BETWEEN period.period_start AND period.period_end
     ORDER BY period.period_start DESC, period.period_id
     LIMIT 2`,
    [householdId, bookId, occurredOn],
  );
  return result.rows.length === 1 ? PeriodIdSchema.parse(result.rows[0]!.period_id) : undefined;
}

async function requireScopedPeriodId(
  pools: DatabasePools,
  householdId: string,
  bookId: ReturnType<typeof BookIdSchema.parse>,
  periodId: PeriodId,
): Promise<PeriodId> {
  const result = await pools.accounting.query<{ period_id: string }>(
    `SELECT period.period_id
     FROM accounting.periods period
     JOIN operations.households household ON household.id = period.household_id
     JOIN accounting.books book ON book.id = period.book_id
     WHERE household.household_id = $1
       AND book.book_id = $2
       AND period.period_id = $3
     LIMIT 2`,
    [householdId, bookId, periodId],
  );
  if (result.rows.length === 1) return PeriodIdSchema.parse(result.rows[0]!.period_id);
  throw materializationError(
    'validation_rejected',
    'transaction_period_out_of_scope',
    'The supplied accounting period is outside the household book scope',
  );
}

async function requireScopedMappingByReference(
  pools: DatabasePools,
  householdId: string,
  bookId: ReturnType<typeof BookIdSchema.parse>,
  sourceSystem: string | undefined,
  externalAccountId: string | undefined,
): Promise<AccountSourceMappingId> {
  if (sourceSystem === undefined || externalAccountId === undefined) {
    throw materializationError(
      'validation_rejected',
      'chart_target_mapping_missing',
      'Replacing a source mapping requires both source system and external account reference',
    );
  }
  const result = await pools.accounting.query<{ mapping_id: string }>(
    `SELECT mapping.mapping_id
     FROM accounting.account_source_mappings mapping
     JOIN operations.households household ON household.id = mapping.household_id
     JOIN accounting.books book ON book.id = mapping.book_id
     WHERE household.household_id = $1
       AND book.book_id = $2
       AND mapping.source_system = $3
       AND mapping.external_account_id = $4
       AND mapping.archived_at IS NULL
     ORDER BY mapping.mapping_id
     LIMIT 2`,
    [householdId, bookId, sourceSystem, externalAccountId],
  );
  if (result.rows.length === 1) return AccountSourceMappingIdSchema.parse(result.rows[0]!.mapping_id);
  throw materializationError(
    result.rows.length === 0 ? 'validation_rejected' : 'ambiguous_source_match',
    `chart_target_mapping_${result.rows.length === 0 ? 'missing' : 'ambiguous'}`,
    result.rows.length === 0
      ? 'The requested source mapping was not found in this household book'
      : 'The requested source mapping reference matches multiple household mappings',
  );
}

async function requireScopedMappingById(
  pools: DatabasePools,
  householdId: string,
  bookId: ReturnType<typeof BookIdSchema.parse>,
  mappingId: AccountSourceMappingId,
): Promise<AccountSourceMappingId> {
  const result = await pools.accounting.query<{ mapping_id: string }>(
    `SELECT mapping.mapping_id
     FROM accounting.account_source_mappings mapping
     JOIN operations.households household ON household.id = mapping.household_id
     JOIN accounting.books book ON book.id = mapping.book_id
     WHERE household.household_id = $1
       AND book.book_id = $2
       AND mapping.mapping_id = $3
       AND mapping.archived_at IS NULL
     LIMIT 2`,
    [householdId, bookId, mappingId],
  );
  if (result.rows.length === 1) return AccountSourceMappingIdSchema.parse(result.rows[0]!.mapping_id);
  throw materializationError(
    'validation_rejected',
    'chart_target_mapping_out_of_scope',
    'The supplied source mapping is outside the active household book scope',
  );
}

type ImportBatchMatch = {
  importBatchId: ReturnType<typeof ImportBatchIdSchema.parse>;
  artifact: CheckedArtifactReference;
};

type CheckedArtifactReference = {
  artifactId: ReturnType<typeof ArtifactIdSchema.parse>;
  artifactHash: ReturnType<typeof ArtifactHashSchema.parse>;
  taskId: TaskId;
};

async function resolveImportBatchById(
  input: AccountingMaterializationContext,
  importBatchId: ReturnType<typeof ImportBatchIdSchema.parse>,
): Promise<ImportBatchMatch> {
  const result = await input.pools.accounting.query<{
    import_batch_id: string;
    artifact_id: string;
    artifact_hash: string;
    task_id: string;
  }>(
    `SELECT batch.import_batch_id, artifact.artifact_id, artifact.artifact_hash, artifact.task_id
     FROM ingestion.import_batches batch
     JOIN operations.households household ON household.id = batch.household_id
     JOIN operations.artifacts artifact ON artifact.id = batch.checked_artifact_id
     WHERE household.household_id = $1
       AND batch.import_batch_id = $2
       AND artifact.artifact_type = 'maker_output'
       AND EXISTS (
         SELECT 1
         FROM operations.checker_verdicts verdict
         WHERE verdict.household_id = artifact.household_id
           AND verdict.task_id = artifact.task_id
           AND verdict.covered_artifact_id = artifact.artifact_id
           AND verdict.covered_artifact_hash = artifact.artifact_hash
           AND verdict.verdict = 'accepted'
       )
     LIMIT 2`,
    [input.message.householdId, importBatchId],
  );
  return requireUniqueImportBatch(result.rows);
}

async function resolveImportBatchByReference(
  input: AccountingMaterializationContext,
  draft: ReturnType<typeof IngestionWorkRequestDraftSchemaV1.parse>,
): Promise<ImportBatchMatch> {
  const uploadReference = inboundAttachmentReference(input.message, draft.sourceReference.attachmentLabel);
  const result = await input.pools.accounting.query<{
    import_batch_id: string;
    artifact_id: string;
    artifact_hash: string;
    task_id: string;
  }>(
    `SELECT batch.import_batch_id, artifact.artifact_id, artifact.artifact_hash, artifact.task_id
     FROM ingestion.import_batches batch
     JOIN operations.households household ON household.id = batch.household_id
     JOIN ingestion.source_documents source ON source.id = batch.source_document_id
     JOIN operations.artifacts artifact ON artifact.id = batch.checked_artifact_id
     WHERE household.household_id = $1
       AND source.upload_reference = $2
       AND ($3::text IS NULL OR lower(source.source_system) = lower($3))
       AND artifact.artifact_type = 'maker_output'
       AND EXISTS (
         SELECT 1
         FROM operations.checker_verdicts verdict
         WHERE verdict.household_id = artifact.household_id
           AND verdict.task_id = artifact.task_id
           AND verdict.covered_artifact_id = artifact.artifact_id
           AND verdict.covered_artifact_hash = artifact.artifact_hash
           AND verdict.verdict = 'accepted'
       )
     ORDER BY batch.import_batch_id
     LIMIT 2`,
    [input.message.householdId, uploadReference, draft.sourceReference.sourceSystem ?? null],
  );
  return requireUniqueImportBatch(result.rows);
}

function requireUniqueImportBatch(rows: readonly {
  import_batch_id: string;
  artifact_id: string;
  artifact_hash: string;
  task_id: string;
}[]): ImportBatchMatch {
  if (rows.length === 1) {
    return {
      importBatchId: ImportBatchIdSchema.parse(rows[0]!.import_batch_id),
      artifact: {
        artifactId: ArtifactIdSchema.parse(rows[0]!.artifact_id),
        artifactHash: ArtifactHashSchema.parse(rows[0]!.artifact_hash),
        taskId: TaskIdSchema.parse(rows[0]!.task_id),
      },
    };
  }
  throw materializationError(
    rows.length === 0 ? 'validation_rejected' : 'ambiguous_source_match',
    `ingestion_import_batch_${rows.length === 0 ? 'missing' : 'ambiguous'}`,
    rows.length === 0
      ? 'No checked import batch matches this inbound source reference'
      : 'More than one checked import batch matches this inbound source reference',
  );
}

type SnapshotMatch = {
  accountId: AccountId;
  statementSnapshotId: ReturnType<typeof StatementSnapshotIdSchema.parse>;
  artifacts: CheckedArtifactReference[];
};

async function resolveSnapshotByReference(
  input: AccountingMaterializationContext,
  bookId: ReturnType<typeof BookIdSchema.parse>,
  draft: ReturnType<typeof ReconciliationWorkRequestDraftSchemaV1.parse>,
): Promise<SnapshotMatch> {
  if (!messageContainsReference(input.message, draft.statementReference)) {
    throw materializationError(
      'validation_rejected',
      'reconciliation_statement_not_in_message',
      'The requested statement reference is not present in the inbound message',
    );
  }
  const accountId = await requireScopedAccountByName(
    input.pools,
    input.message.householdId,
    bookId,
    draft.accountName,
    'reconciliation_account',
  );
  const result = await input.pools.accounting.query<{
    statement_snapshot_id: string;
    artifact_refs: unknown;
  }>(
    `SELECT snapshot.statement_snapshot_id,
       jsonb_agg(jsonb_build_object(
         'artifactId', artifact.artifact_id,
         'artifactHash', artifact.artifact_hash,
         'taskId', artifact.task_id
       ) ORDER BY artifact.artifact_id) AS artifact_refs
     FROM ingestion.statement_snapshots snapshot
     JOIN operations.households household ON household.id = snapshot.household_id
     JOIN accounting.books book ON book.household_id = household.id
     JOIN accounting.accounts account ON account.id = snapshot.account_id AND account.book_id = book.id
     JOIN ingestion.source_documents source ON source.id = snapshot.source_document_id
     JOIN ingestion.import_batches batch ON batch.source_document_id = source.id
     JOIN operations.artifacts artifact ON artifact.id = batch.checked_artifact_id
     WHERE household.household_id = $1
       AND book.book_id = $2
       AND account.account_id = $3
       AND (source.upload_reference = $4
         OR source.source_document_id = $4
         OR snapshot.statement_snapshot_id = $4)
       AND artifact.artifact_type = 'maker_output'
       AND EXISTS (
         SELECT 1
         FROM operations.checker_verdicts verdict
         WHERE verdict.household_id = artifact.household_id
           AND verdict.task_id = artifact.task_id
           AND verdict.covered_artifact_id = artifact.artifact_id
           AND verdict.covered_artifact_hash = artifact.artifact_hash
           AND verdict.verdict = 'accepted'
       )
     GROUP BY snapshot.statement_snapshot_id
     ORDER BY snapshot.statement_snapshot_id
     LIMIT 2`,
    [input.message.householdId, bookId, accountId, draft.statementReference],
  );
  return requireUniqueSnapshot(result.rows, accountId);
}

async function resolveSnapshotById(
  input: AccountingMaterializationContext,
  bookId: ReturnType<typeof BookIdSchema.parse>,
  requestedAccountId: AccountId,
  statementSnapshotId: ReturnType<typeof StatementSnapshotIdSchema.parse>,
): Promise<SnapshotMatch> {
  const accountId = (await requireScopedAccountById(
    input.pools,
    input.message.householdId,
    bookId,
    requestedAccountId,
    undefined,
    'reconciliation_account_out_of_scope',
  )).accountId;
  const result = await input.pools.accounting.query<{
    statement_snapshot_id: string;
    artifact_refs: unknown;
  }>(
    `SELECT snapshot.statement_snapshot_id,
       jsonb_agg(jsonb_build_object(
         'artifactId', artifact.artifact_id,
         'artifactHash', artifact.artifact_hash,
         'taskId', artifact.task_id
       ) ORDER BY artifact.artifact_id) AS artifact_refs
     FROM ingestion.statement_snapshots snapshot
     JOIN operations.households household ON household.id = snapshot.household_id
     JOIN accounting.books book ON book.household_id = household.id
     JOIN accounting.accounts account ON account.id = snapshot.account_id AND account.book_id = book.id
     JOIN ingestion.source_documents source ON source.id = snapshot.source_document_id
     JOIN ingestion.import_batches batch ON batch.source_document_id = source.id
     JOIN operations.artifacts artifact ON artifact.id = batch.checked_artifact_id
     WHERE household.household_id = $1
       AND book.book_id = $2
       AND account.account_id = $3
       AND snapshot.statement_snapshot_id = $4
       AND artifact.artifact_type = 'maker_output'
       AND EXISTS (
         SELECT 1
         FROM operations.checker_verdicts verdict
         WHERE verdict.household_id = artifact.household_id
           AND verdict.task_id = artifact.task_id
           AND verdict.covered_artifact_id = artifact.artifact_id
           AND verdict.covered_artifact_hash = artifact.artifact_hash
           AND verdict.verdict = 'accepted'
       )
     GROUP BY snapshot.statement_snapshot_id
     LIMIT 2`,
    [input.message.householdId, bookId, accountId, statementSnapshotId],
  );
  return requireUniqueSnapshot(result.rows, accountId);
}

function requireUniqueSnapshot(
  rows: readonly { statement_snapshot_id: string; artifact_refs: unknown }[],
  accountId: AccountId,
): SnapshotMatch {
  if (rows.length === 1) {
    const artifacts = parseCheckedArtifactReferences(rows[0]!.artifact_refs);
    return {
      accountId,
      statementSnapshotId: StatementSnapshotIdSchema.parse(rows[0]!.statement_snapshot_id),
      artifacts,
    };
  }
  throw materializationError(
    rows.length === 0 ? 'validation_rejected' : 'ambiguous_source_match',
    `reconciliation_statement_${rows.length === 0 ? 'missing' : 'ambiguous'}`,
    rows.length === 0
      ? 'No checked statement snapshot matches this household account'
      : 'More than one statement snapshot matches this household account',
  );
}

function parseCheckedArtifactReferences(value: unknown): CheckedArtifactReference[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw materializationError(
      'validation_rejected',
      'checked_artifact_reference_missing',
      'The statement snapshot does not have checked evidence artifacts',
    );
  }
  const references = value.map((entry) => {
    if (entry === null || typeof entry !== 'object'
      || !('artifactId' in entry) || !('artifactHash' in entry) || !('taskId' in entry)) {
      throw materializationError(
        'validation_rejected',
        'checked_artifact_reference_invalid',
        'The statement snapshot has an invalid checked evidence reference',
      );
    }
    return {
      artifactId: ArtifactIdSchema.parse(entry.artifactId),
      artifactHash: ArtifactHashSchema.parse(entry.artifactHash),
      taskId: TaskIdSchema.parse(entry.taskId),
    };
  });
  if (new Set(references.map((reference) => reference.artifactId)).size !== references.length) {
    throw materializationError(
      'ambiguous_source_match',
      'checked_artifact_reference_ambiguous',
      'The statement snapshot has duplicate checked evidence references',
    );
  }
  return references;
}

async function loadCheckedArtifact(
  input: AccountingMaterializationContext,
  reference: CheckedArtifactReference,
): Promise<ArtifactEnvelopeV1> {
  const artifact = await input.artifacts.getVerified(reference.artifactId);
  if (artifact.householdId !== input.message.householdId
    || artifact.taskId !== reference.taskId
    || artifact.artifactHash !== reference.artifactHash
    || artifact.artifactType !== 'maker_output') {
    throw materializationError(
      'validation_rejected',
      'checked_artifact_incompatible',
      'The resolved artifact is not compatible with this household checked-work request',
    );
  }
  return artifact;
}

function inboundAttachmentReference(message: InboundChannelMessageV1, attachmentLabel: string | undefined): string {
  if (attachmentLabel === undefined) return message.externalMessageId;
  if (message.attachments.some((attachment) => containsReference(attachment, attachmentLabel))) {
    return attachmentLabel;
  }
  throw materializationError(
    'validation_rejected',
    'ingestion_attachment_not_found',
    'The requested attachment reference is not present in the inbound message',
  );
}

function messageContainsReference(message: InboundChannelMessageV1, reference: string): boolean {
  return message.body.toLocaleLowerCase().includes(reference.toLocaleLowerCase())
    || message.attachments.some((attachment) => containsReference(attachment, reference));
}

function containsReference(value: unknown, reference: string): boolean {
  if (typeof value === 'string') return value.toLocaleLowerCase() === reference.toLocaleLowerCase();
  if (Array.isArray(value)) return value.some((entry) => containsReference(entry, reference));
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some((entry) => containsReference(entry, reference));
  }
  return false;
}

function materializationError(
  category: 'validation_rejected' | 'ambiguous_source_match',
  code: string,
  message: string,
  details: Record<string, string | number | boolean | null> = {},
): PlusOneError {
  return new PlusOneError({
    category,
    code,
    message,
    retry: 'after_state_resolution',
    receiptLookupRequired: false,
    details,
  });
}
