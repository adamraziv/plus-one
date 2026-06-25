import { randomBytes } from 'node:crypto';
import {
  PostgresArtifactRepository,
  PostgresVerificationLedgerRepository,
  type DatabasePools,
} from '@plus-one/database';
import {
  AccountingLeadRequestSchemaV1,
  TransactionCaptureRequestSchemaV1,
  accountingSkills,
  type AccountingLeadRequestV1,
} from '@plus-one/accounting';
import {
  PlusOneError,
  EvidenceRequestSchemaV1,
  TeamLeadPlanSchemaV1,
  type InboundChannelMessageV1,
  type JsonValue,
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
      const plan = deterministicLeadPlanForRequest(runtimeInput.team, request)
        ?? await planner.plan({
          householdId: runtimeInput.message.householdId,
          taskId: leadTaskId,
          team: runtimeInput.team,
          selectedSkill: leadSkill.identity,
          request,
          policyLabels: ['personalized_finance'],
          abortSignal: runtimeInput.signal,
        });
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
  if (!parsed.success || parsed.data.intent !== 'transaction_capture') return request;
  if (TransactionCaptureRequestSchemaV1.safeParse(parsed.data.request).success) return request;

  const bookId = await resolveHouseholdBookId(pools, message.householdId);
  const normalized = AccountingLeadRequestSchemaV1.parse({
    schemaName: 'accounting-lead-request',
    schemaVersion: 1,
    intent: 'transaction_capture',
    request: TransactionCaptureRequestSchemaV1.parse({
      schemaName: 'transaction-capture-request',
      schemaVersion: 1,
      householdId: message.householdId,
      bookId,
      explicitInstruction: true,
      instruction: instructionText(message, parsed.data),
      known: {
        ...(amountFrom(message.body, parsed.data) === undefined ? {} : { amount: amountFrom(message.body, parsed.data) }),
        ...(currencyFrom(message.body, parsed.data) === undefined ? {} : { currency: currencyFrom(message.body, parsed.data) }),
      },
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

  const businessQuestion = queryBusinessQuestion(message, request);
  const date = message.receivedAt.slice(0, 10);
  return JSON.parse(JSON.stringify(EvidenceRequestSchemaV1.parse({
    schemaName: 'evidence-request',
    schemaVersion: 1,
    householdId: message.householdId,
    requestId: nextId('evidence'),
    businessQuestion,
    intendedUse: 'household_finance_answer',
    timeframe: { start: date, end: date },
    desiredGrain: desiredGrainForQuestion(businessQuestion),
    filters: [],
    requiredFreshness: 'latest available reporting projection',
    requiredCalculations: [],
    coverage: [coverageForQuestion(businessQuestion)],
  }))) as JsonValue;
}

export function makerInputForLeadWorkItem(
  team: TeamDefinition,
  workCellId: string,
  planMakerInput: JsonValue,
  normalizedRequest: JsonValue,
): JsonValue {
  if (team.team === 'query'
    && workCellId === 'query-evidence'
    && EvidenceRequestSchemaV1.safeParse(normalizedRequest).success) {
    return normalizedRequest;
  }
  return planMakerInput;
}

export function deterministicLeadPlanForRequest(
  team: TeamDefinition,
  request: JsonValue,
) {
  if (team.team !== 'query') return undefined;
  const parsed = EvidenceRequestSchemaV1.safeParse(request);
  if (!parsed.success || parsed.data.requiredCalculations.length > 0) return undefined;
  return TeamLeadPlanSchemaV1.parse({
    schemaName: 'team-lead-plan',
    schemaVersion: 1,
    recommendedStrategyName: 'single-maker-checker',
    work: [{ workCellId: 'query-evidence', makerInput: request }],
    stopCondition: { code: 'query-answer', description: 'Return one checked query answer.' },
  });
}

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

function amountFrom(body: string, request: AccountingLeadRequestV1): string | undefined {
  const nested = request.request;
  if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
    const amount = nested.amount;
    if (typeof amount === 'string' && amount.length > 0) return amount;
    if (typeof amount === 'number' && Number.isFinite(amount)) return amount.toFixed(2);
  }
  const match = body.match(/\$([0-9]+(?:\.[0-9]{1,2})?)/);
  return match?.[1] === undefined ? undefined : Number.parseFloat(match[1]).toFixed(2);
}

function currencyFrom(body: string, request: AccountingLeadRequestV1): string | undefined {
  const nested = request.request;
  if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
    const currency = nested.currency;
    if (typeof currency === 'string' && currency.length > 0) return currency;
  }
  return body.includes('$') ? 'USD' : undefined;
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

function isAccountListQuestion(question: string): boolean {
  const normalized = question.trim().toLowerCase();
  return /(?:^|\b)(list|show|what|which)\b[\s\w]*\baccounts?\b/.test(normalized)
    && !/\bbalances?\b/.test(normalized);
}

function coverageForQuestion(question: string): string {
  const normalized = question.trim().toLowerCase();
  if (isAccountListQuestion(normalized)) return 'account list';
  if (/\bbalances?\b/.test(normalized)) return 'balance snapshot';
  if (/\btransactions?\b|\bspend(?:ing|s)?\b|\bspent\b/.test(normalized)) return 'categorized transactions';
  if (/\bbudget\b|\bvariance\b/.test(normalized)) return 'budget variance';
  if (/\bsavings?\b|\bgoals?\b/.test(normalized)) return 'savings goal progress';
  if (/\bdebt\b|\bloan\b|\bliabilit(?:y|ies)\b/.test(normalized)) return 'debt progress';
  if (/\breconcil(?:e|iation)\b|\bstatement\b/.test(normalized)) return 'reconciliation status';
  if (/\bfreshness\b|\bstale\b|\bsource\b/.test(normalized)) return 'source freshness';
  return 'requested household finance answer';
}

function desiredGrainForQuestion(question: string): string[] {
  const coverage = coverageForQuestion(question);
  if (coverage === 'account list' || coverage === 'balance snapshot' || coverage === 'debt progress'
    || coverage === 'reconciliation status') {
    return ['household', 'account'];
  }
  if (coverage === 'categorized transactions') return ['household', 'account', 'journal'];
  if (coverage === 'budget variance') return ['household', 'category'];
  if (coverage === 'savings goal progress') return ['household', 'goal'];
  if (coverage === 'source freshness') return ['household', 'source'];
  return ['household'];
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
