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
  BudgetPlanRequestDraftSchemaV1,
  BudgetScenarioRequestDraftSchemaV1,
  BudgetingDelegateRequestSchemaV1,
  BudgetingIntakeRequestSchemaV1,
  MaterializedBudgetingLeadRequestSchemaV1,
  planningSkills,
  validateBudgetingLeadPlan,
} from '@plus-one/planning';
import {
  queryRelationForCoverage,
  querySkills,
  queryToolNameForCoverage,
  readReportingRelationGrain,
  type ReportingRelationMetadataReader,
} from '@plus-one/query';
import { reportingSkills } from '@plus-one/reporting';
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
import { QueryLeadRequestDraftSchemaV1 } from './tools/delegate-team-schemas.js';
import { DefaultChartMutationRuntime } from './accounting/chart-mutation-runtime.js';

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
          ? normalizeBudgetingLeadRequest(runtimeInput.message, runtimeInput.request)
        : runtimeInput.team.team === 'query'
          ? await normalizeQueryLeadRequest(input.pools, runtimeInput.message, runtimeInput.request)
          : runtimeInput.request;
      const suggestedPlan = suggestedLeadPlanForRequest(runtimeInput.team, request);
      const accountingRequest = runtimeInput.team.team === 'accounting'
        ? MaterializedAccountingLeadRequestSchemaV1.safeParse(request)
        : undefined;
      const budgetingRequest = runtimeInput.team.team === 'budgeting'
        ? MaterializedBudgetingLeadRequestSchemaV1.safeParse(request)
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
                : planCandidate,
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
              item.makerInput,
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

export function normalizeBudgetingLeadRequest(
  message: InboundChannelMessageV1,
  request: JsonValue,
): JsonValue {
  const parsed = BudgetingDelegateRequestSchemaV1.parse(request);
  const materializedRequest = parsed.intent === 'budget_plan'
    ? (() => {
        const draft = BudgetPlanRequestDraftSchemaV1.parse(parsed.request);
        return BudgetingIntakeRequestSchemaV1.parse({
          schemaName: 'budgeting-intake-request',
          schemaVersion: 1,
          householdId: message.householdId,
          intent: parsed.intent,
          instruction: draft.instruction,
          scopeKey: draft.scopeKey,
        });
      })()
    : (() => {
        const draft = BudgetScenarioRequestDraftSchemaV1.parse(parsed.request);
        return BudgetingIntakeRequestSchemaV1.parse({
          schemaName: 'budgeting-intake-request',
          schemaVersion: 1,
          householdId: message.householdId,
          intent: parsed.intent,
          instruction: draft.instruction,
          scenarioCount: draft.scenarioCount,
        });
      })();

  return JSON.parse(JSON.stringify(MaterializedBudgetingLeadRequestSchemaV1.parse({
    ...parsed,
    request: materializedRequest,
  }))) as JsonValue;
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
  planMakerInput: JsonValue,
  normalizedRequest: JsonValue,
): JsonValue {
  if (team.team === 'query' && workCellId === 'query-evidence') {
    const normalized = EvidenceRequestSchemaV1.safeParse(normalizedRequest);
    if (normalized.success) return JSON.parse(JSON.stringify(normalized.data)) as JsonValue;
    const plan = EvidenceRequestSchemaV1.safeParse(planMakerInput);
    if (plan.success) return JSON.parse(JSON.stringify(plan.data)) as JsonValue;
  }
  return planMakerInput;
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
