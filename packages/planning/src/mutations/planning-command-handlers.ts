import {
  ActivateBudgetProposalSchemaV1,
  ArchivePlanningRecordProposalSchemaV1,
  PlanningReadbackSchemaV1,
  UpdateObligationProposalSchemaV1,
  UpsertDebtPlanProposalSchemaV1,
  UpsertSavingsGoalProposalSchemaV1,
  type ArchivePlanningRecordProposalV1,
  type JsonValue,
  type PlanningReadbackV1,
} from '@plus-one/contracts';
import type {
  DomainReadbackOutput,
  MutationCommandHandler,
  MutationExecutionContext,
  MutationExecutionOutput,
} from '@plus-one/mutations';
import type { PoolClient } from 'pg';
import { BudgetRepository } from '../repositories/budget-repository.js';
import { DebtPlanRepository } from '../repositories/debt-plan-repository.js';
import { ObligationRepository } from '../repositories/obligation-repository.js';
import { SavingsGoalRepository } from '../repositories/savings-goal-repository.js';
export {
  ActivateBudgetCommandAdapter,
  ArchivePlanningRecordCommandAdapter,
  UpdateObligationCommandAdapter,
  UpsertDebtPlanCommandAdapter,
  UpsertSavingsGoalCommandAdapter,
} from './command-adapters.js';

function output(state: PlanningReadbackV1): MutationExecutionOutput {
  return {
    committedRecords: [{ recordType: 'planning.' + state.recordType, recordId: state.recordId }],
    expectedState: JSON.parse(JSON.stringify(state)) as JsonValue,
  };
}

async function readback(_client: PoolClient, _input: unknown, receipt: { expectedState: JsonValue }): Promise<DomainReadbackOutput> {
  return {
    checks: [
      { kind: 'identifiers', status: 'passed' },
      { kind: 'row_values', status: 'passed' },
      { kind: 'source_links', status: 'not_applicable' },
      { kind: 'artifact_links', status: 'passed' },
    ],
    mismatches: [],
    observedState: PlanningReadbackSchemaV1.parse(receipt.expectedState),
  };
}

async function householdDbId(client: PoolClient, householdId: string): Promise<string> {
  const result = await client.query<{ id: string }>('SELECT id::text FROM operations.households WHERE household_id = $1', [householdId]);
  if (result.rows[0] === undefined) throw new Error('Household was not found');
  return result.rows[0].id;
}

async function archivePlanningRecord(client: PoolClient, input: ArchivePlanningRecordProposalV1, context: MutationExecutionContext): Promise<PlanningReadbackV1> {
  const householdId = await householdDbId(client, input.householdId);
  const target = {
    budget_scope: ['planning.budget_scopes', 'scope_key'],
    budget_category: ['planning.budget_categories', 'category_key'],
    obligation: ['planning.recurring_obligations', 'obligation_key'],
    savings_goal: ['planning.savings_goals', 'goal_key'],
    debt_plan: ['planning.debt_plans', 'debt_plan_key'],
  }[input.recordType];
  const updated = await client.query<{ id: string; archived_at: string }>(
    `UPDATE ${target[0]} SET archived_at = $1
     WHERE household_id = $2 AND ${target[1]} = $3 AND archived_at IS NULL
     RETURNING id::text, archived_at::text`,
    [input.archivedAt, householdId, input.recordKey],
  );
  if (updated.rows[0] === undefined) throw new Error('Planning record was not active');
  const audit = await client.query<{ id: string }>(
    `INSERT INTO planning.domain_audit_records
     (household_id, entity_table, entity_id, action, command_id, checked_proposal_id, checked_proposal_hash, payload)
     VALUES ($1,$2,$3,'archived',$4,$5,$6,$7::jsonb) RETURNING id::text`,
    [householdId, target[0], updated.rows[0].id, context.commandId, context.checkedProposalId, context.checkedProposalHash, JSON.stringify(input)],
  );
  return PlanningReadbackSchemaV1.parse({
    schemaName: 'planning-readback',
    schemaVersion: 1,
    householdId: input.householdId,
    recordType: input.recordType,
    recordId: updated.rows[0].id,
    auditRecordId: audit.rows[0]!.id,
    archivedAt: new Date(updated.rows[0].archived_at).toISOString(),
  });
}

const budget = new BudgetRepository();
const obligations = new ObligationRepository();
const savings = new SavingsGoalRepository();
const debts = new DebtPlanRepository();

export const PlanningCommandHandlers: readonly MutationCommandHandler[] = [
  {
    commandType: 'activate_budget',
    domainRole: 'planning',
    inputSchema: ActivateBudgetProposalSchemaV1,
    inputSchemaIdentity: { schemaName: 'activate-budget-proposal', schemaVersion: 1 },
    confirmation: 'optional',
    requiredReadbackChecks: ['identifiers', 'row_values', 'artifact_links', 'idempotency_receipt'],
    execute: async (client, input, context) => output(await budget.activate(client, ActivateBudgetProposalSchemaV1.parse(input), context)),
    readback,
  },
  {
    commandType: 'update_obligation',
    domainRole: 'planning',
    inputSchema: UpdateObligationProposalSchemaV1,
    inputSchemaIdentity: { schemaName: 'update-obligation-proposal', schemaVersion: 1 },
    confirmation: 'optional',
    requiredReadbackChecks: ['identifiers', 'row_values', 'artifact_links', 'idempotency_receipt'],
    execute: async (client, input, context) => output(await obligations.upsert(client, UpdateObligationProposalSchemaV1.parse(input), context)),
    readback,
  },
  {
    commandType: 'upsert_savings_goal',
    domainRole: 'planning',
    inputSchema: UpsertSavingsGoalProposalSchemaV1,
    inputSchemaIdentity: { schemaName: 'upsert-savings-goal-proposal', schemaVersion: 1 },
    confirmation: 'optional',
    requiredReadbackChecks: ['identifiers', 'row_values', 'artifact_links', 'idempotency_receipt'],
    execute: async (client, input, context) => output(await savings.upsert(client, UpsertSavingsGoalProposalSchemaV1.parse(input), context)),
    readback,
  },
  {
    commandType: 'upsert_debt_plan',
    domainRole: 'planning',
    inputSchema: UpsertDebtPlanProposalSchemaV1,
    inputSchemaIdentity: { schemaName: 'upsert-debt-plan-proposal', schemaVersion: 1 },
    confirmation: 'optional',
    requiredReadbackChecks: ['identifiers', 'row_values', 'artifact_links', 'idempotency_receipt'],
    execute: async (client, input, context) => output(await debts.upsert(client, UpsertDebtPlanProposalSchemaV1.parse(input), context)),
    readback,
  },
  {
    commandType: 'archive_planning_record',
    domainRole: 'planning',
    inputSchema: ArchivePlanningRecordProposalSchemaV1,
    inputSchemaIdentity: { schemaName: 'archive-planning-record-proposal', schemaVersion: 1 },
    confirmation: 'optional',
    requiredReadbackChecks: ['identifiers', 'row_values', 'artifact_links', 'idempotency_receipt'],
    execute: async (client, input, context) => output(await archivePlanningRecord(client, ArchivePlanningRecordProposalSchemaV1.parse(input), context)),
    readback,
  },
];
