import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  PostgresArtifactRepository,
  PostgresVerificationLedgerRepository,
  type DatabasePools,
} from '@plus-one/database';
import {
  AccountingLeadRequestSchemaV1,
  JournalWorkRequestSchemaV1,
  TransactionCaptureRequestSchemaV1,
  accountingSkills,
  validateAccountingLeadPlan,
  type AccountingLeadRequestV1,
  type TransactionCaptureRequestV1,
} from '@plus-one/accounting';
import {
  PlusOneError,
  EvidenceRequestSchemaV1,
  TeamLeadPlanSchemaV1,
  type AccountId,
  type CurrencyCode,
  type InboundChannelMessageV1,
  type JsonValue,
  type PeriodId,
} from '@plus-one/contracts';
import { ingestionSkills } from '@plus-one/ingestion';
import { planningSkills } from '@plus-one/planning';
import { querySkills } from '@plus-one/query';
import { reportingSkills } from '@plus-one/reporting';
import {
  AgentInvocationRunner,
  ArtifactStore,
  ExecutionStrategyRegistry,
  TeamExecutionCoordinator,
  TeamExecutor,
  TeamLeadPlanner,
  TeamResultAssembler,
  VerificationRuntime,
  findWorkCell,
  type SkillRegistration,
  type TeamDefinition,
  type WorkCellDefinition,
} from '@plus-one/runtime';
import type { AgentSystem } from './agent-catalog.js';
import type { OrchestratorTeamRuntime } from './tools/delegate-team.js';
import {
  QueryLeadRequestDraftSchemaV1,
  TransactionCaptureRequestDraftSchemaV1,
  type TransactionCaptureRequestDraftV1,
} from './tools/delegate-team-schemas.js';

const skills = [
  ...querySkills,
  ...accountingSkills,
  ...ingestionSkills,
  ...planningSkills,
  ...reportingSkills,
] as const;

export function createTeamRuntime(input: {
  pools: DatabasePools;
  agentSystem: AgentSystem;
}): OrchestratorTeamRuntime {
  const strategies = ExecutionStrategyRegistry.withRequiredStrategies();
  const ledger = new PostgresVerificationLedgerRepository(input.pools.operations);
  const runtime = new VerificationRuntime({
    ledger,
    artifacts: new ArtifactStore(new PostgresArtifactRepository(input.pools.operations)),
    policies: input.agentSystem.policies,
  });
  const runner = new AgentInvocationRunner({
    agents: input.agentSystem.adapter,
    policies: input.agentSystem.policies,
    ledger,
    ids: { nextRunId: () => nextId('run') },
  });
  const planner = new TeamLeadPlanner({
    runner,
    contexts: input.agentSystem.contexts,
    strategies,
  });
  const executor = new TeamExecutor({
    runtime,
    runner,
    contexts: input.agentSystem.contexts,
    policies: input.agentSystem.policies,
    ids: { nextArtifactId: () => nextId('artifact') },
  });
  const coordinator = new TeamExecutionCoordinator({
    executor,
    strategies,
    assembler: new TeamResultAssembler(),
  });

  return {
    runTeamLead: async (runtimeInput) => {
      const leadTaskId = nextId('task');
      const resultTaskId = nextId('task');
      const leadSkill = findLeadSkill(runtimeInput.team);
      const leadPolicy = input.agentSystem.policies.resolve(runtimeInput.team.lead.runtimePolicy);
      const request = runtimeInput.team.team === 'accounting'
        ? await normalizeAccountingLeadRequest(input.pools, runtimeInput.message, runtimeInput.request)
        : runtimeInput.team.team === 'query'
          ? normalizeQueryLeadRequest(runtimeInput.message, runtimeInput.request)
          : runtimeInput.request;
      await runtime.createTask({
        householdId: runtimeInput.message.householdId,
        taskId: leadTaskId,
        team: runtimeInput.team.team,
        attemptLimit: leadPolicy.maxAttempts,
        deadlineAt: new Date(Date.now() + leadPolicy.teamDeadlineMs).toISOString(),
      });
      const planCandidate = deterministicLeadPlanForRequest(runtimeInput.team, request)
        ?? await planner.plan({
          householdId: runtimeInput.message.householdId,
          taskId: leadTaskId,
          team: runtimeInput.team,
          selectedSkill: leadSkill.identity,
          request,
          policyLabels: ['personalized_finance'],
          abortSignal: runtimeInput.signal,
        });
      const accountingRequest = runtimeInput.team.team === 'accounting'
        ? AccountingLeadRequestSchemaV1.safeParse(request)
        : undefined;
      const plan = accountingRequest?.success
        ? validateAccountingLeadPlan(accountingRequest.data, planCandidate)
        : planCandidate;
      const work = plan.work.map((item) => workInputFor(runtimeInput.team, item.workCellId, {
        householdId: runtimeInput.message.householdId,
        parentTaskId: leadTaskId,
        makerInput: makerInputForLeadWorkItem(runtimeInput.team, item.workCellId, item.makerInput, request),
        stopCondition: plan.stopCondition,
        strategyName: plan.recommendedStrategyName,
        abortSignal: runtimeInput.signal,
      }));

      return coordinator.execute({
        team: runtimeInput.team,
        strategyName: plan.recommendedStrategyName,
        selectedSkill: work[0]!.selectedSkill,
        resultTaskId,
        work,
        stopCondition: plan.stopCondition,
      });
    },
  };
}

export async function normalizeAccountingLeadRequest(
  pools: DatabasePools,
  message: InboundChannelMessageV1,
  request: JsonValue,
): Promise<JsonValue> {
  const parsed = AccountingLeadRequestSchemaV1.safeParse(request);
  if (!parsed.success) return request;
  if (parsed.data.intent === 'journal') {
    if (JournalWorkRequestSchemaV1.safeParse(parsed.data.request).success) return request;
    const draft = JournalWorkRequestDraftSchema.safeParse(parsed.data.request);
    if (!draft.success) return request;
    const bookId = await resolveHouseholdBookId(pools, message.householdId);
    return JSON.parse(JSON.stringify(AccountingLeadRequestSchemaV1.parse({
      schemaName: 'accounting-lead-request',
      schemaVersion: 1,
      intent: 'journal',
      request: JournalWorkRequestSchemaV1.parse({
        schemaName: 'journal-work-request',
        schemaVersion: 1,
        householdId: message.householdId,
        bookId,
        operation: draft.data.operation,
        instruction: draft.data.instruction,
      }),
    }))) as JsonValue;
  }
  if (parsed.data.intent !== 'transaction_capture') return request;
  const transactionCapture = TransactionCaptureRequestSchemaV1.safeParse(parsed.data.request);
  if (transactionCapture.success) {
    const enriched = await enrichTransactionCaptureRequest(pools, transactionCapture.data);
    return JSON.parse(JSON.stringify(AccountingLeadRequestSchemaV1.parse({
      schemaName: 'accounting-lead-request',
      schemaVersion: 1,
      intent: 'transaction_capture',
      request: enriched,
    }))) as JsonValue;
  }

  const draft = TransactionCaptureRequestDraftSchemaV1.safeParse(parsed.data.request);
  const bookId = await resolveHouseholdBookId(pools, message.householdId);
  const resolvedKnown = draft.success
    ? await canonicalTransactionKnown(pools, message.householdId, bookId, draft.data.known)
    : { known: {} };
  const periodId = resolvedKnown.known.occurredOn === undefined
    ? undefined
    : await resolvePeriodIdForOccurredOn(
      pools,
      message.householdId,
      bookId,
      resolvedKnown.known.occurredOn,
    );
  const normalized = AccountingLeadRequestSchemaV1.parse({
    schemaName: 'accounting-lead-request',
    schemaVersion: 1,
    intent: 'transaction_capture',
    request: TransactionCaptureRequestSchemaV1.parse({
      schemaName: 'transaction-capture-request',
      schemaVersion: 1,
      householdId: message.householdId,
      bookId,
      ...(periodId === undefined ? {} : { periodId }),
      explicitInstruction: true,
      instruction: draft.success ? draft.data.instruction : instructionText(message, parsed.data),
      ...(resolvedKnown.paymentAccountCurrency === undefined
        ? {}
        : { paymentAccountCurrency: resolvedKnown.paymentAccountCurrency }),
      ...(resolvedKnown.categoryAccountCurrency === undefined
        ? {}
        : { categoryAccountCurrency: resolvedKnown.categoryAccountCurrency }),
      known: resolvedKnown.known,
    }),
  });
  return JSON.parse(JSON.stringify(normalized)) as JsonValue;
}

export function normalizeQueryLeadRequest(
  message: InboundChannelMessageV1,
  request: JsonValue,
): JsonValue {
  const parsed = EvidenceRequestSchemaV1.safeParse(request);
  if (parsed.success) return JSON.parse(JSON.stringify(parsed.data)) as JsonValue;

  const draft = QueryLeadRequestDraftSchemaV1.safeParse(request);
  const businessQuestion = draft.success ? draft.data.businessQuestion : queryBusinessQuestion(message, request);
  const date = message.receivedAt.slice(0, 10);
  return JSON.parse(JSON.stringify(EvidenceRequestSchemaV1.parse({
    schemaName: 'evidence-request',
    schemaVersion: 1,
    householdId: message.householdId,
    requestId: nextId('evidence'),
    businessQuestion,
    intendedUse: 'household_finance_answer',
    timeframe: draft.success && draft.data.timeframe !== undefined
      ? draft.data.timeframe
      : { start: date, end: date },
    desiredGrain: draft.success && draft.data.desiredGrain !== undefined
      ? draft.data.desiredGrain
      : ['household'],
    filters: [],
    requiredFreshness: 'latest available reporting projection',
    requiredCalculations: draft.success ? draft.data.requiredCalculations : [],
    coverage: draft.success && draft.data.coverage !== undefined
      ? draft.data.coverage
      : ['requested household finance answer'],
  }))) as JsonValue;
}

export function makerInputForLeadWorkItem(
  team: TeamDefinition,
  workCellId: string,
  planMakerInput: JsonValue,
  normalizedRequest: JsonValue,
): JsonValue {
  if (team.team === 'query' && workCellId === 'query-evidence') {
    const plan = EvidenceRequestSchemaV1.safeParse(planMakerInput);
    if (plan.success) return JSON.parse(JSON.stringify(plan.data)) as JsonValue;
    if (EvidenceRequestSchemaV1.safeParse(normalizedRequest).success) return normalizedRequest;
  }
  return planMakerInput;
}

export function deterministicLeadPlanForRequest(
  team: TeamDefinition,
  request: JsonValue,
) {
  if (team.team === 'query') {
    const parsed = EvidenceRequestSchemaV1.safeParse(request);
    if (!parsed.success
      || parsed.data.requiredCalculations.length > 0
      || !parsed.data.coverage.some((coverage) => deterministicQueryCoverages.has(coverage))) {
      return undefined;
    }
    return TeamLeadPlanSchemaV1.parse({
      schemaName: 'team-lead-plan',
      schemaVersion: 1,
      recommendedStrategyName: 'single-maker-checker',
      work: [{ workCellId: 'query-evidence', makerInput: request }],
      stopCondition: { code: 'query-answer', description: 'Return one checked query answer.' },
    });
  }
  if (team.team === 'accounting') {
    const parsed = AccountingLeadRequestSchemaV1.safeParse(request);
    if (!parsed.success) return undefined;
    const plan = deterministicAccountingPlans[parsed.data.intent];
    return TeamLeadPlanSchemaV1.parse({
      schemaName: 'team-lead-plan',
      schemaVersion: 1,
      recommendedStrategyName: 'single-maker-checker',
      work: [{ workCellId: plan.workCellId, makerInput: parsed.data.request }],
      stopCondition: {
        code: plan.stopCode,
        description: plan.stopDescription,
      },
    });
  }
  return undefined;
}

const deterministicQueryCoverages = new Set([
  'account list',
  'reporting.accounts',
  'balance snapshot',
  'reporting.current_balances',
  'reporting.account_current_balances',
  'categorized transactions',
  'reporting.categorized_transactions',
  'category spend monthly',
  'reporting.category_spend_monthly',
  'budget variance',
  'reporting.budget_variance',
  'savings goal progress',
  'reporting.savings_goal_progress',
  'debt progress',
  'reporting.debt_progress',
  'reconciliation status',
  'reporting.reconciliation_status',
  'source freshness',
  'reporting.source_freshness',
]);

const deterministicAccountingPlans = {
  transaction_capture: {
    workCellId: 'transaction-capture',
    stopCode: 'checked-transaction-capture',
    stopDescription: 'Return one checked accounting result.',
  },
  ingestion: {
    workCellId: 'ingestion',
    stopCode: 'checked-ingestion',
    stopDescription: 'Return one checked import proposal.',
  },
  journal: {
    workCellId: 'journal',
    stopCode: 'checked-journal',
    stopDescription: 'Return one checked accounting result.',
  },
  chart_of_accounts: {
    workCellId: 'chart-of-accounts',
    stopCode: 'checked-chart-change',
    stopDescription: 'Return one checked chart change.',
  },
  reconciliation: {
    workCellId: 'reconciliation',
    stopCode: 'checked-reconciliation',
    stopDescription: 'Return one checked reconciliation proposal.',
  },
} as const;

const JournalWorkRequestDraftSchema = z.object({
  operation: z.enum(['post', 'transfer', 'split', 'adjustment', 'reverse_replace', 'fx_realized']),
  instruction: z.string().min(1).max(4_000),
}).strict();

const PaymentAccountIdSchemaV1 =
  TransactionCaptureRequestSchemaV1.shape.known.shape.paymentAccountId.unwrap();
const TransactionCaptureCurrencySchemaV1 =
  TransactionCaptureRequestSchemaV1.shape.paymentAccountCurrency.unwrap();
const TransactionCapturePeriodIdSchemaV1 =
  TransactionCaptureRequestSchemaV1.shape.periodId.unwrap();

async function resolveHouseholdBookId(pools: DatabasePools, householdId: string): Promise<string> {
  const result = await pools.accounting.query<{ book_id: string }>(
    `SELECT book.book_id
     FROM accounting.books book
     JOIN operations.households household ON household.id = book.household_id
     WHERE household.household_id = $1
     ORDER BY book.book_id
     LIMIT 2`,
    [householdId],
  );
  if (result.rows.length === 1) return result.rows[0]!.book_id;
  throw new PlusOneError({
    category: 'validation_rejected',
    code: 'household_book_not_found',
    message: 'Accounting requests require exactly one household book',
    retry: 'after_state_resolution',
    receiptLookupRequired: false,
    details: { householdId, matchedBooks: result.rows.length },
  });
}

function instructionText(message: InboundChannelMessageV1, request: AccountingLeadRequestV1): string {
  const nested = request.request;
  if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
    const instruction = nested.instruction;
    if (typeof instruction === 'string' && instruction.length > 0) return instruction;
  }
  return message.body;
}

async function enrichTransactionCaptureRequest(
  pools: DatabasePools,
  request: TransactionCaptureRequestV1,
) {
  const paymentAccountCurrency = request.paymentAccountCurrency === undefined
    && request.known.paymentAccountId !== undefined
    ? await resolveAccountCurrencyById(
      pools,
      request.householdId,
      request.bookId,
      request.known.paymentAccountId,
    )
    : request.paymentAccountCurrency;
  const categoryAccountCurrency = request.categoryAccountCurrency === undefined
    && request.known.categoryAccountId !== undefined
    ? await resolveAccountCurrencyById(
      pools,
      request.householdId,
      request.bookId,
      request.known.categoryAccountId,
    )
    : request.categoryAccountCurrency;
  const periodId = request.periodId === undefined && request.known.occurredOn !== undefined
    ? await resolvePeriodIdForOccurredOn(
      pools,
      request.householdId,
      request.bookId,
      request.known.occurredOn,
    )
    : request.periodId;
  return TransactionCaptureRequestSchemaV1.parse({
    ...request,
    ...(periodId === undefined ? {} : { periodId }),
    ...(paymentAccountCurrency === undefined ? {} : { paymentAccountCurrency }),
    ...(categoryAccountCurrency === undefined ? {} : { categoryAccountCurrency }),
  });
}

async function canonicalTransactionKnown(
  pools: DatabasePools,
  householdId: string,
  bookId: string,
  known: TransactionCaptureRequestDraftV1['known'],
): Promise<{
  known: TransactionCaptureRequestV1['known'];
  paymentAccountCurrency?: CurrencyCode;
  categoryAccountCurrency?: CurrencyCode;
}> {
  const paymentAccount = known.paymentAccountName === undefined
    ? undefined
    : await resolveAccountByName(
      pools,
      householdId,
      bookId,
      known.paymentAccountName,
      paymentAccountingClasses,
    );
  const categoryAccount = known.categoryName === undefined
    ? undefined
    : await resolveAccountByName(
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

async function resolveAccountByName(
  pools: DatabasePools,
  householdId: string,
  bookId: string,
  accountName: string,
  allowedClasses: readonly string[],
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
       AND account.accounting_class = ANY($4::text[])
       AND account.archived_at IS NULL
     ORDER BY account.account_id
     LIMIT 2`,
    [householdId, bookId, normalizedName, allowedClasses],
  );
  return result.rows.length === 1
    ? {
      accountId: PaymentAccountIdSchemaV1.parse(result.rows[0]!.account_id),
      nativeCurrency: TransactionCaptureCurrencySchemaV1.parse(result.rows[0]!.native_currency),
    }
    : undefined;
}

async function resolveAccountCurrencyById(
  pools: DatabasePools,
  householdId: string,
  bookId: string,
  accountId: AccountId,
): Promise<CurrencyCode | undefined> {
  const result = await pools.accounting.query<{ native_currency: string }>(
    `SELECT account.native_currency
     FROM accounting.accounts account
     JOIN operations.households household ON household.id = account.household_id
     JOIN accounting.books book ON book.id = account.book_id
     WHERE household.household_id = $1
       AND book.book_id = $2
       AND account.account_id = $3
       AND account.archived_at IS NULL
     LIMIT 2`,
    [householdId, bookId, accountId],
  );
  return result.rows.length === 1
    ? TransactionCaptureCurrencySchemaV1.parse(result.rows[0]!.native_currency)
    : undefined;
}

async function resolvePeriodIdForOccurredOn(
  pools: DatabasePools,
  householdId: string,
  bookId: string,
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
  return result.rows.length === 1
    ? TransactionCapturePeriodIdSchemaV1.parse(result.rows[0]!.period_id)
    : undefined;
}

function queryBusinessQuestion(message: InboundChannelMessageV1, request: JsonValue): string {
  if (typeof request === 'object' && request !== null && !Array.isArray(request)) {
    const businessQuestion = request.businessQuestion;
    if (typeof businessQuestion === 'string' && businessQuestion.trim().length > 0) {
      return businessQuestion.trim();
    }
  }
  return message.body.trim();
}

function workInputFor(
  team: TeamDefinition,
  workCellId: string,
  input: {
    householdId: string;
    parentTaskId: string;
    makerInput: JsonValue;
    stopCondition: { code: string; description: string };
    strategyName: string;
    abortSignal: AbortSignal;
  },
) {
  const workCell = findWorkCell(team, workCellId);
  const selectedSkill = findWorkCellSkill(team, workCell);

  return {
    householdId: input.householdId,
    taskId: nextId('task'),
    parentTaskId: input.parentTaskId,
    team: team.team,
    workCell,
    selectedSkill: selectedSkill.identity,
    makerInput: input.makerInput,
    permittedEvidence: [],
    policyLabels: ['personalized_finance'],
    stopCondition: input.stopCondition,
    strategyName: input.strategyName,
    abortSignal: input.abortSignal,
  };
}

function findLeadSkill(team: TeamDefinition): SkillRegistration {
  return findSkill((skill) =>
    skill.allowedTeams.includes(team.team)
    && skill.allowedRoles.includes(team.lead.identity.roleName),
  );
}

function findWorkCellSkill(team: TeamDefinition, workCell: WorkCellDefinition): SkillRegistration {
  return findSkill((skill) =>
    skill.allowedTeams.includes(team.team)
    && skill.allowedRoles.includes(workCell.maker.identity.roleName)
    && workCell.allowedSkillNames.includes(skill.identity.skillName),
  );
}

function findSkill(predicate: (skill: SkillRegistration) => boolean): SkillRegistration {
  const skill = skills.find(predicate);
  if (skill === undefined) throw new Error('Missing runtime skill registration');
  return skill;
}

function nextId(prefix: 'artifact' | 'evidence' | 'run' | 'task'): string {
  return `${prefix}_${ulid()}`;
}

function ulid(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = Date.now();
  let output = '';

  for (let index = 0; index < 10; index += 1) {
    output = alphabet[time % 32] + output;
    time = Math.floor(time / 32);
  }

  const randomness = randomBytes(16);
  let buffer = 0;
  let bits = 0;
  for (const byte of randomness) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < 26) {
      bits -= 5;
      output += alphabet[(buffer >> bits) & 31];
    }
  }

  while (output.length < 26) output += alphabet[0];
  return output;
}
