import { randomBytes } from 'node:crypto';
import {
  PostgresDomainCommandBridge,
  PostgresMutationCommandRepository,
  PostgresArtifactRepository,
  PostgresVerificationLedgerRepository,
  type DatabasePools,
} from '@plus-one/database';
import {
  AccountingJournalCommandAdapter,
  accountingSkills,
  createAccountingJournalMutationHandler,
  validateAccountingLeadPlan,
} from '@plus-one/accounting';
import {
  AccountIdSchema,
  AccountSourceMappingIdSchema,
  EvidenceRequestSchemaV1,
  PeriodIdSchema,
  QuerySpecificationSchemaV1,
  TeamLeadPlanSchemaV1,
  type InboundChannelMessageV1,
  type JsonValue,
  type TeamResultStatusV1,
} from '@plus-one/contracts';
import {
  CheckedMutationExecutor,
  CheckedMutationWorkCellCoordinator,
  CommandRegistry,
  CommandStateResolver,
  SerializableMutationRunner,
} from '@plus-one/mutations';
import { ingestionSkills } from '@plus-one/ingestion';
import {
  ActivateBudgetCommandAdapter,
  BudgetPlanRequestDraftSchemaV1,
  BudgetPlanRequestSchemaV1,
  BudgetScenarioRequestSchemaV1,
  BudgetScenarioRequestDraftSchemaV1,
  BudgetingDelegateRequestSchemaV1,
  BudgetingIntakeRequestSchemaV1,
  CashFlowAnalysisRequestSchemaV1,
  CashFlowLeadRequestSchemaV1,
  missingBudgetPlanFields,
  missingBudgetScenarioFields,
  MaterializedBudgetingLeadRequestSchemaV1,
  PlanningCommandHandlers,
  planningSkills,
  type BudgetingDelegateRequestV1,
  validateBudgetingLeadPlan,
  validateCashFlowLeadPlan,
} from '@plus-one/planning';
import {
  queryRelationForCoverage,
  querySkills,
  queryToolNameForCoverage,
  readReportingRelationGrain,
  type ReportingRelationMetadataReader,
} from '@plus-one/query';
import {
  InvestmentEducationRequestSchemaV1,
  InvestmentsRetirementLeadRequestSchemaV1,
  RecordsFactRequestSchemaV1,
  RecordsReportingLeadRequestSchemaV1,
  RetirementEducationRequestSchemaV1,
  reportingSkills,
  validateInvestmentsRetirementLeadPlan,
  validateRecordsReportingLeadPlan,
} from '@plus-one/reporting';
import {
  AgentInvocationRunner,
  ArtifactStore,
  ExecutionStrategyRegistry,
  TeamExecutionCoordinator,
  TeamExecutor,
  TeamLeadPlanner,
  TeamLeadSupervisor,
  TeamResultAssembler,
  VerificationRuntime,
  findWorkCell,
  type CheckedWorkCellResult,
  type SkillRegistration,
  type SupervisedWorkExecution,
  type TeamDefinition,
  type WorkCellDefinition,
} from '@plus-one/runtime';
import { createChartOfAccountsMutationHandler, AccountingMutationService } from '@plus-one/accounting';
import type { AgentSystem } from './agent-catalog.js';
import type { OrchestratorTeamRuntime } from './tools/delegate-team.js';
import {
  AccountingDelegateRequestSchemaV1,
  MaterializedAccountingLeadRequestSchemaV1,
} from './accounting/accounting-lead-contracts.js';
import { materializeAccountingLeadRequest } from './accounting/accounting-request-materializers.js';
import {
  CashFlowRequestDraftSchemaV1,
  EducationRequestDraftSchemaV1,
  QueryLeadRequestDraftSchemaV1,
  RecordsFactRequestDraftSchemaV1,
} from './tools/delegate-team-schemas.js';
import { DefaultChartMutationRuntime } from './accounting/chart-mutation-runtime.js';
import { withDefaultEvidenceHandle } from './query-tools.js';
import { canonicalBudgetingDraft } from './budgeting/budgeting-request.js';

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
  const artifacts = new ArtifactStore(new PostgresArtifactRepository(input.pools.operations));
  const runtime = new VerificationRuntime({
    ledger,
    artifacts,
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
  const commands = new PostgresMutationCommandRepository(input.pools.operations);
  const clientRouter = {
    connect: (role: 'accounting' | 'planning') => input.pools[role].connect(),
  };
  const resolver = new CommandStateResolver({ commands, ledger });
  const mutationRunner = new SerializableMutationRunner({
    clients: clientRouter,
    bridge: new PostgresDomainCommandBridge(),
    findReceipt: (householdId, commandId) => commands.findReceiptByCommand(householdId, commandId),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: () => Date.now(),
  });
  const mutationExecutor = new CheckedMutationExecutor({
    artifacts,
    ledger,
    commands,
    resolver,
    registry: new CommandRegistry([
      createAccountingJournalMutationHandler(),
      createChartOfAccountsMutationHandler(),
      ...PlanningCommandHandlers,
    ]),
    runner: mutationRunner,
    readClients: clientRouter,
    newReadbackId: () => nextId('readback'),
  });
  const checkedMutations = new CheckedMutationWorkCellCoordinator({
    teamExecutor: executor,
    mutationExecutor,
    runtime,
    ledger,
  });
  const chartMutations = new DefaultChartMutationRuntime({
    service: new AccountingMutationService(checkedMutations),
    assembler: new TeamResultAssembler(),
    commands,
    coordinator: checkedMutations,
    verification: runtime,
    nextCommandId: () => nextId('command'),
    nextIdempotencyKey: () => nextId('idem'),
    nextConfirmationId: () => nextId('confirm'),
  });

  return {
    runTeamLead: async (runtimeInput) => {
      const resultTaskId = nextId('task');
      const leadSkill = findLeadSkill(runtimeInput.team);
      const leadPolicy = input.agentSystem.policies.resolve(runtimeInput.team.lead.runtimePolicy);
      const request = runtimeInput.team.team === 'accounting'
        ? await normalizeAccountingLeadRequest(input.pools, runtimeInput.message, runtimeInput.request, {
          artifacts,
          allocateAccountId: () => AccountIdSchema.parse(nextId('account')),
          allocateAccountMappingId: () => AccountSourceMappingIdSchema.parse(nextId('accountmap')),
          allocatePeriodId: () => PeriodIdSchema.parse(nextId('period')),
        })
        : runtimeInput.team.team === 'budgeting'
          ? await materializeBudgetingLeadRequest(
              input.pools,
              runtimeInput.message,
              runtimeInput.request,
            )
        : runtimeInput.team.team === 'query'
          ? await normalizeQueryLeadRequest(input.pools, runtimeInput.message, runtimeInput.request)
          : runtimeInput.team.team === 'cash-flow'
            ? await materializeCashFlowLeadRequest(
                input.pools,
                runtimeInput.message,
                runtimeInput.request,
              )
            : runtimeInput.team.team === 'investments-retirement'
              ? await materializeInvestmentsRetirementLeadRequest(
                  input.pools,
                  runtimeInput.message,
                  runtimeInput.request,
                )
              : runtimeInput.team.team === 'records-reporting'
                ? await materializeRecordsReportingLeadRequest(
                    input.pools,
                    runtimeInput.message,
                    runtimeInput.request,
                  )
          : runtimeInput.request;
      const suggestedPlan = suggestedLeadPlanForRequest(runtimeInput.team, request);
      const accountingRequest = runtimeInput.team.team === 'accounting'
        ? MaterializedAccountingLeadRequestSchemaV1.safeParse(request)
        : undefined;
      const budgetingRequest = runtimeInput.team.team === 'budgeting'
        ? MaterializedBudgetingLeadRequestSchemaV1.safeParse(request)
        : undefined;
      const cashFlowRequest = runtimeInput.team.team === 'cash-flow'
        ? CashFlowLeadRequestSchemaV1.safeParse(request)
        : undefined;
      const investmentsRetirementRequest = runtimeInput.team.team === 'investments-retirement'
        ? InvestmentsRetirementLeadRequestSchemaV1.safeParse(request)
        : undefined;
      const recordsReportingRequest = runtimeInput.team.team === 'records-reporting'
        ? RecordsReportingLeadRequestSchemaV1.safeParse(request)
        : undefined;
      const attemptLimit = Math.min(8, Math.max(...runtimeInput.team.workCells.map((cell) => {
        const maker = input.agentSystem.policies.resolve(cell.maker.runtimePolicy);
        const checker = input.agentSystem.policies.resolve(cell.checker.runtimePolicy);
        return Math.min(maker.maxAttempts, checker.maxAttempts);
      })));
      const deadlineAt = new Date(Date.now() + leadPolicy.endToEndDeadlineMs).toISOString();
      const supervisionSignal = AbortSignal.any([
        runtimeInput.signal,
        AbortSignal.timeout(leadPolicy.endToEndDeadlineMs),
      ]);
      const leadTaskIds = new Map<number, string>();
      return new TeamLeadSupervisor().run({
        attemptLimit,
        plan: async (executionState, executionOrdinal) => {
          const leadTaskId = nextId('task');
          leadTaskIds.set(executionOrdinal, leadTaskId);
          await runtime.createTask({
            householdId: runtimeInput.message.householdId,
            taskId: leadTaskId,
            team: runtimeInput.team.team,
            attemptLimit: leadPolicy.maxAttempts,
            deadlineAt,
          });
          return planner.plan({
            householdId: runtimeInput.message.householdId,
            taskId: leadTaskId,
            team: runtimeInput.team,
            selectedSkill: leadSkill.identity,
            request,
            policyLabels: ['personalized_finance'],
            ...(suggestedPlan === undefined ? {} : { suggestedPlan }),
            executionState,
            validatePlan: (planCandidate) => accountingRequest?.success
              ? validateAccountingLeadPlan(accountingRequest.data, planCandidate)
              : budgetingRequest?.success
                ? validateBudgetingLeadPlan(budgetingRequest.data, planCandidate)
                : cashFlowRequest?.success
                  ? validateCashFlowLeadPlan(cashFlowRequest.data, planCandidate)
                  : investmentsRetirementRequest?.success
                    ? validateInvestmentsRetirementLeadPlan(
                        investmentsRetirementRequest.data,
                        planCandidate,
                      )
                    : recordsReportingRequest?.success
                      ? validateRecordsReportingLeadPlan(recordsReportingRequest.data, planCandidate)
                      : planCandidate,
            resolveMakerInput: (workCellId) => makerInputForLeadWorkItem(
              runtimeInput.team,
              workCellId,
              request,
            ),
            abortSignal: supervisionSignal,
          });
        },
        execute: async (plan, executionOrdinal) => {
          const leadTaskId = leadTaskIds.get(executionOrdinal);
          if (leadTaskId === undefined) throw new Error('Missing lead task for supervised execution');
          const work = plan.work.map((item) => workInputFor(runtimeInput.team, item.workCellId, {
            householdId: runtimeInput.message.householdId,
            parentTaskId: leadTaskId,
            makerInput: makerInputForLeadWorkItem(
              runtimeInput.team,
              item.workCellId,
              request,
            ),
            stopCondition: plan.stopCondition,
            strategyName: plan.recommendedStrategyName,
            abortSignal: supervisionSignal,
          }));
          const resultMetadata = {
            householdId: runtimeInput.message.householdId,
            resultTaskId,
            team: runtimeInput.team.team,
            strategyName: plan.recommendedStrategyName,
            selectedSkill: work[0]!.selectedSkill,
            stopCondition: plan.stopCondition,
          };
          if (plan.work.length === 1 && plan.work[0]?.workCellId === 'chart-of-accounts') {
            const result = await chartMutations.prepare({
              workCellInput: work[0]!,
              resultMetadata,
            });
            return {
              result,
              work: supervisedWorkExecutions(work, [], result.status),
            };
          }
          if (plan.work.length === 1 && plan.work[0]?.workCellId === 'budget-plan') {
            const prepared = await checkedMutations.prepare({
              workCellInput: work[0]!,
              commandId: nextId('command'),
              idempotencyKey: nextId('idem'),
              adapter: new ActivateBudgetCommandAdapter(),
            });
            const checked = prepared.completionState === 'checked_mutation_pending'
              ? await checkedMutations.executePrepared({ prepared })
              : prepared;
            const result = new TeamResultAssembler().assemble({
              ...resultMetadata,
              results: [checked],
            });
            return {
              result,
              work: supervisedWorkExecutions(work, [checked], result.status),
            };
          }
          if (plan.work.length === 1
            && (plan.work[0]?.workCellId === 'transaction-capture'
              || plan.work[0]?.workCellId === 'journal')) {
            const prepared = await checkedMutations.prepare({
              workCellInput: work[0]!,
              commandId: nextId('command'),
              idempotencyKey: nextId('idem'),
              adapter: new AccountingJournalCommandAdapter(),
            });
            const checked = prepared.completionState === 'checked_mutation_pending'
              ? await checkedMutations.executePrepared({ prepared })
              : prepared;
            const result = new TeamResultAssembler().assemble({
              ...resultMetadata,
              results: [checked],
            });
            return {
              result,
              work: supervisedWorkExecutions(work, [checked], result.status),
            };
          }
          const execution = await coordinator.executeWithDetails({
            team: runtimeInput.team,
            strategyName: plan.recommendedStrategyName,
            selectedSkill: work[0]!.selectedSkill,
            resultTaskId,
            work,
            stopCondition: plan.stopCondition,
          });
          return {
            result: execution.result,
            work: supervisedWorkExecutions(work, execution.work, execution.result.status),
          };
        },
      });
    },
    resumePendingMutation: async ({ message, pending, signal }) => {
      if (signal.aborted) throw signal.reason ?? new DOMException('Mutation resume aborted.', 'AbortError');
      return chartMutations.resume({ message, pending });
    },
    cancelPendingMutation: async ({ pending, signal }) => {
      if (signal.aborted) throw signal.reason ?? new DOMException('Mutation cancellation aborted.', 'AbortError');
      await chartMutations.cancel({ pending });
    },
  };
}

export async function normalizeAccountingLeadRequest(
  pools: DatabasePools,
  message: InboundChannelMessageV1,
  request: JsonValue,
  dependencies: {
    artifacts?: ArtifactStore;
    allocateAccountId?: () => ReturnType<typeof AccountIdSchema.parse>;
    allocateAccountMappingId?: () => ReturnType<typeof AccountSourceMappingIdSchema.parse>;
    allocatePeriodId?: () => ReturnType<typeof PeriodIdSchema.parse>;
  } = {},
): Promise<JsonValue> {
  const normalized = await materializeAccountingLeadRequest({
    pools,
    artifacts: dependencies.artifacts
      ?? new ArtifactStore(new PostgresArtifactRepository(pools.operations)),
    message,
    request,
    allocateAccountId: dependencies.allocateAccountId
      ?? (() => AccountIdSchema.parse(nextId('account'))),
    allocateAccountMappingId: dependencies.allocateAccountMappingId
      ?? (() => AccountSourceMappingIdSchema.parse(nextId('accountmap'))),
    allocatePeriodId: dependencies.allocatePeriodId
      ?? (() => PeriodIdSchema.parse(nextId('period'))),
  });
  return JSON.parse(JSON.stringify(normalized)) as JsonValue;
}

export function budgetingIntakeForDraft(
  message: InboundChannelMessageV1,
  request: BudgetingDelegateRequestV1,
) {
  return budgetingIntakeForCanonicalDraft(message, canonicalBudgetingDraft(message, request));
}

function budgetingIntakeForCanonicalDraft(
  message: InboundChannelMessageV1,
  request: BudgetingDelegateRequestV1,
) {
  const missing = request.intent === 'budget_plan'
    ? missingBudgetPlanFields(request.request.known)
    : missingBudgetScenarioFields(request.request.known);
  if (missing.length === 0) return undefined;
  return request.intent === 'budget_plan'
    ? BudgetingIntakeRequestSchemaV1.parse({
        schemaName: 'budgeting-intake-request',
        schemaVersion: 1,
        householdId: message.householdId,
        intent: request.intent,
        instruction: request.request.instruction,
        scopeKey: request.request.scopeKey,
        known: request.request.known,
      })
    : BudgetingIntakeRequestSchemaV1.parse({
        schemaName: 'budgeting-intake-request',
        schemaVersion: 1,
        householdId: message.householdId,
        intent: request.intent,
        instruction: request.request.instruction,
        scenarioCount: request.request.scenarioCount,
        known: request.request.known,
      });
}

export async function materializeBudgetingLeadRequest(
  pools: DatabasePools,
  message: InboundChannelMessageV1,
  request: JsonValue,
): Promise<JsonValue> {
  const parsed = BudgetingDelegateRequestSchemaV1.parse(request);
  const canonical = canonicalBudgetingDraft(message, parsed);
  const intake = budgetingIntakeForCanonicalDraft(message, canonical);
  if (intake !== undefined) {
    return JSON.parse(JSON.stringify(MaterializedBudgetingLeadRequestSchemaV1.parse({
      ...canonical,
      request: intake,
    }))) as JsonValue;
  }

  const evidencePackage = await buildBudgetingEvidencePackage(pools, message);
  const accountContext = await planningAccountContext(pools, message.householdId);
  const materializedRequest = parsed.intent === 'budget_plan'
    ? (() => {
        const draft = BudgetPlanRequestDraftSchemaV1.parse(canonical.request);
        return BudgetPlanRequestSchemaV1.parse({
          schemaName: 'budget-plan-request',
          schemaVersion: 1,
          householdId: message.householdId,
          evidencePackage,
          instruction: appendRuntimeContext(draft.instruction, accountContext),
          scopeKey: draft.scopeKey,
          known: draft.known,
        });
      })()
    : (() => {
        const draft = BudgetScenarioRequestDraftSchemaV1.parse(canonical.request);
        return BudgetScenarioRequestSchemaV1.parse({
          schemaName: 'budget-scenario-request',
          schemaVersion: 1,
          householdId: message.householdId,
          evidencePackage,
          instruction: appendRuntimeContext(draft.instruction, accountContext),
          scenarioCount: draft.scenarioCount,
          known: draft.known,
        });
      })();
  return JSON.parse(JSON.stringify(MaterializedBudgetingLeadRequestSchemaV1.parse({
    ...canonical,
    request: materializedRequest,
  }))) as JsonValue;
}

async function buildBudgetingEvidencePackage(
  pools: Pick<DatabasePools, 'query'>,
  message: InboundChannelMessageV1,
) {
  const date = message.receivedAt.slice(0, 10);
  const desiredGrain = await readReportingRelationGrain(
    queryMetadataReader(pools),
    'reporting.accounts',
  );
  const request = EvidenceRequestSchemaV1.parse({
    schemaName: 'evidence-request',
    schemaVersion: 1,
    householdId: message.householdId,
    requestId: nextId('evidence'),
    businessQuestion: 'Which active accounts can be mapped into this household budget?',
    intendedUse: 'budget_planning',
    timeframe: { start: date, end: date },
    desiredGrain,
    filters: [{ field: 'household_id', op: 'eq', value: message.householdId }],
    requiredFreshness: 'latest available reporting projection',
    requiredCalculations: [],
    coverage: ['account list'],
  });
  const householdLiteral = message.householdId.replaceAll("'", "''");
  const querySpecification = QuerySpecificationSchemaV1.parse({
    schemaName: 'query-specification',
    schemaVersion: 1,
    relationNames: ['reporting.accounts'],
    sql: `SELECT account_id, name FROM reporting.accounts WHERE household_id = '${householdLiteral}' LIMIT 100`,
    filters: request.filters,
    limit: 100,
  });
  return withDefaultEvidenceHandle(pools, (handle) => handle.buildEvidencePackage({
    request,
    querySpecification,
  }));
}

async function materializeCashFlowLeadRequest(
  pools: DatabasePools,
  message: InboundChannelMessageV1,
  request: JsonValue,
): Promise<JsonValue> {
  const parsed = CashFlowLeadRequestSchemaV1.parse(request);
  const draft = CashFlowRequestDraftSchemaV1.parse(parsed.request);
  const evidencePackage = await buildRuntimeEvidencePackage(pools, message, {
    relationName: 'reporting.budget_variance',
    selectList: 'budget_version_id, budget_name, scope_key, category_key, period_start, period_end, planned_amount, planned_currency, actual_amount',
    businessQuestion: draft.objective,
    intendedUse: 'cash_flow_analysis',
    coverage: 'budget variance',
    ...(draft.timeframe === undefined ? {} : { timeframe: draft.timeframe }),
  });
  const materialized = CashFlowAnalysisRequestSchemaV1.parse({
    schemaName: 'cash-flow-analysis-request',
    schemaVersion: 1,
    householdId: message.householdId,
    evidencePackage,
    objective: draft.objective,
    analysisMode: draft.analysisMode,
  });
  const canonical = JSON.parse(JSON.stringify({
    ...parsed,
    request: materialized,
  })) as JsonValue;
  return JSON.parse(JSON.stringify(CashFlowLeadRequestSchemaV1.parse(canonical))) as JsonValue;
}

async function materializeInvestmentsRetirementLeadRequest(
  pools: DatabasePools,
  message: InboundChannelMessageV1,
  request: JsonValue,
): Promise<JsonValue> {
  const parsed = InvestmentsRetirementLeadRequestSchemaV1.parse(request);
  const draft = EducationRequestDraftSchemaV1.parse(parsed.request);
  const evidencePackage = await buildRuntimeEvidencePackage(pools, message, {
    relationName: 'reporting.accounts',
    selectList: 'account_id, name',
    businessQuestion: draft.question,
    intendedUse: parsed.intent,
    coverage: 'account list',
  });
  const materialized = parsed.intent === 'investment_education'
    ? InvestmentEducationRequestSchemaV1.parse({
        schemaName: 'investment-education-request',
        schemaVersion: 1,
        householdId: message.householdId,
        evidencePackage,
        question: draft.question,
      })
    : RetirementEducationRequestSchemaV1.parse({
        schemaName: 'retirement-education-request',
        schemaVersion: 1,
        householdId: message.householdId,
        evidencePackage,
        question: draft.question,
      });
  const canonical = JSON.parse(JSON.stringify({
    ...parsed,
    request: materialized,
  })) as JsonValue;
  return JSON.parse(JSON.stringify(
    InvestmentsRetirementLeadRequestSchemaV1.parse(canonical),
  )) as JsonValue;
}

async function materializeRecordsReportingLeadRequest(
  pools: DatabasePools,
  message: InboundChannelMessageV1,
  request: JsonValue,
): Promise<JsonValue> {
  const parsed = RecordsReportingLeadRequestSchemaV1.parse(request);
  if (parsed.intent !== 'records_facts') return JSON.parse(JSON.stringify(parsed)) as JsonValue;
  const draft = RecordsFactRequestDraftSchemaV1.parse(parsed.request);
  const evidencePackage = await buildRuntimeEvidencePackage(pools, message, {
    relationName: 'reporting.accounts',
    selectList: 'account_id, name',
    businessQuestion: draft.focus,
    intendedUse: 'records_facts',
    coverage: 'account list',
  });
  const materialized = RecordsFactRequestSchemaV1.parse({
    schemaName: 'records-fact-request',
    schemaVersion: 1,
    householdId: message.householdId,
    evidencePackage,
    focus: draft.focus,
  });
  const canonical = JSON.parse(JSON.stringify({
    ...parsed,
    request: materialized,
  })) as JsonValue;
  return JSON.parse(JSON.stringify(RecordsReportingLeadRequestSchemaV1.parse(canonical))) as JsonValue;
}

async function buildRuntimeEvidencePackage(
  pools: Pick<DatabasePools, 'query'>,
  message: InboundChannelMessageV1,
  input: {
    relationName: 'reporting.accounts' | 'reporting.budget_variance';
    selectList: string;
    businessQuestion: string;
    intendedUse: string;
    coverage: string;
    timeframe?: { start: string; end: string };
  },
) {
  const date = message.receivedAt.slice(0, 10);
  const timeframe = input.timeframe ?? { start: date, end: date };
  const desiredGrain = await readReportingRelationGrain(
    queryMetadataReader(pools),
    input.relationName,
  );
  const request = EvidenceRequestSchemaV1.parse({
    schemaName: 'evidence-request',
    schemaVersion: 1,
    householdId: message.householdId,
    requestId: nextId('evidence'),
    businessQuestion: input.businessQuestion,
    intendedUse: input.intendedUse,
    timeframe,
    desiredGrain,
    filters: [{ field: 'household_id', op: 'eq', value: message.householdId }],
    requiredFreshness: 'latest available reporting projection',
    requiredCalculations: [],
    coverage: [input.coverage],
  });
  const householdLiteral = message.householdId.replaceAll("'", "''");
  const querySpecification = QuerySpecificationSchemaV1.parse({
    schemaName: 'query-specification',
    schemaVersion: 1,
    relationNames: [input.relationName],
    sql: `SELECT ${input.selectList} FROM ${input.relationName} WHERE household_id = '${householdLiteral}' LIMIT 100`,
    filters: request.filters,
    limit: 100,
  });
  return withDefaultEvidenceHandle(pools, (handle) => handle.buildEvidencePackage({
    request,
    querySpecification,
  }));
}

async function planningAccountContext(
  pools: Pick<DatabasePools, 'accounting'>,
  householdId: string,
): Promise<string> {
  const result = await pools.accounting.query<{
    databaseId: string;
    accountId: string;
    name: string;
  }>(
    `SELECT a.id::text AS "databaseId", a.account_id AS "accountId", a.name
     FROM accounting.accounts a
     JOIN operations.households h ON h.id = a.household_id
     WHERE h.household_id = $1 AND a.archived_at IS NULL
     ORDER BY a.id`,
    [householdId],
  );
  if (result.rows.length === 0) {
    return 'Runtime account evidence contains no active account available for budget mapping.';
  }
  const bindings = result.rows.map((account) =>
    `${account.name.replaceAll(/\s+/g, ' ').trim()} => ${account.databaseId}`).join('; ');
  return `Runtime-resolved planning account bindings (internal; never expose mapping ids): ${bindings}.`;
}

function appendRuntimeContext(instruction: string, context: string): string {
  const combined = `${instruction}\n${context}`;
  return combined.length <= 4_000 ? combined : instruction;
}

export async function normalizeQueryLeadRequest(
  pools: Pick<DatabasePools, 'query'>,
  message: InboundChannelMessageV1,
  request: JsonValue,
): Promise<JsonValue> {
  const parsed = EvidenceRequestSchemaV1.safeParse(request);
  const draft = QueryLeadRequestDraftSchemaV1.safeParse(request);
  const date = message.receivedAt.slice(0, 10);
  const normalized = parsed.success
    ? { ...parsed.data, householdId: message.householdId }
    : EvidenceRequestSchemaV1.parse({
      schemaName: 'evidence-request',
      schemaVersion: 1,
      householdId: message.householdId,
      requestId: nextId('evidence'),
      businessQuestion: draft.success ? draft.data.businessQuestion : queryBusinessQuestion(message, request),
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
    });
  const relationName = queryRelationForCoverage(normalized.coverage);
  const desiredGrain = relationName === undefined
    ? normalized.desiredGrain
    : await readReportingRelationGrain(queryMetadataReader(pools), relationName);
  return JSON.parse(JSON.stringify(EvidenceRequestSchemaV1.parse({
    ...normalized,
    desiredGrain,
  }))) as JsonValue;
}

function queryMetadataReader(pools: Pick<DatabasePools, 'query'>): ReportingRelationMetadataReader {
  return {
    async query<R extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<{ rows: readonly R[] }> {
      const result = await pools.query.query<R>(text, values === undefined ? undefined : [...values]);
      return { rows: result.rows };
    },
  };
}

export function makerInputForLeadWorkItem(
  team: TeamDefinition,
  workCellId: string,
  planMakerInputOrNormalizedRequest: JsonValue,
  legacyNormalizedRequest?: JsonValue,
): JsonValue {
  const normalizedRequest = legacyNormalizedRequest ?? planMakerInputOrNormalizedRequest;
  const suggestedWork = suggestedLeadPlanForRequest(team, normalizedRequest)?.work
    .find((work) => work.workCellId === workCellId);
  if (suggestedWork !== undefined) {
    return JSON.parse(JSON.stringify(suggestedWork.makerInput)) as JsonValue;
  }
  const cell = findWorkCell(team, workCellId);
  const nestedRequest = typeof normalizedRequest === 'object'
    && normalizedRequest !== null
    && !Array.isArray(normalizedRequest)
    && 'request' in normalizedRequest
    ? normalizedRequest.request
    : undefined;
  const legacyPlanMakerInput = legacyNormalizedRequest === undefined
    ? undefined
    : planMakerInputOrNormalizedRequest;
  for (const candidate of [nestedRequest, normalizedRequest, legacyPlanMakerInput]) {
    const parsed = cell.makerInputSchema.safeParse(candidate);
    if (parsed.success) {
      return JSON.parse(JSON.stringify(parsed.data)) as JsonValue;
    }
  }
  throw new TypeError(`No authenticated maker input matches work cell ${workCellId}`);
}

function supervisedWorkExecutions(
  work: readonly ReturnType<typeof workInputFor>[],
  checked: readonly CheckedWorkCellResult[],
  fallbackStatus: TeamResultStatusV1,
): SupervisedWorkExecution[] {
  const byTask = new Map(checked.map((result) => [result.taskId, result]));
  return work.map((item) => {
    const result = byTask.get(item.taskId);
    return {
      taskId: item.taskId,
      workCellId: item.workCell.workCellId,
      role: item.workCell.maker.identity,
      status: result?.status ?? fallbackStatus,
      ...(result?.failure === undefined ? {} : { failure: result.failure }),
    };
  });
}

export function suggestedLeadPlanForRequest(
  team: TeamDefinition,
  request: JsonValue,
) {
  if (team.team === 'query') {
    const parsed = EvidenceRequestSchemaV1.safeParse(request);
    if (!parsed.success
      || parsed.data.requiredCalculations.length > 0
      || queryToolNameForCoverage(parsed.data.coverage) === undefined) {
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
  if (team.team === 'budgeting') {
    const parsed = MaterializedBudgetingLeadRequestSchemaV1.safeParse(request);
    if (!parsed.success) return undefined;
    const intake = BudgetingIntakeRequestSchemaV1.safeParse(parsed.data.request);
    const plan = intake.success
      ? {
          workCellId: 'budgeting-intake',
          stopCode: 'budgeting-intake',
          stopDescription: 'Return one checked budgeting clarification.',
        }
      : parsed.data.intent === 'budget_plan'
        ? {
            workCellId: 'budget-plan',
            stopCode: 'checked-budget-plan',
            stopDescription: 'Return one checked budget plan.',
          }
        : {
            workCellId: 'budget-scenarios',
            stopCode: 'checked-budget-scenarios',
            stopDescription: 'Return one checked budget scenario comparison.',
          };
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
  if (team.team === 'accounting') {
    const parsed = AccountingDelegateRequestSchemaV1.safeParse(request);
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

function nextId(prefix: 'account' | 'accountmap' | 'artifact' | 'command' | 'confirm' | 'evidence' | 'idem' | 'period' | 'readback' | 'run' | 'task'): string {
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
