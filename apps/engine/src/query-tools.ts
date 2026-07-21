import { type DatabasePools } from '@plus-one/database';
import {
  EvidenceSession,
  pgRunner,
  QueryToolRegistry,
  ReadOnlySqlValidator,
  type QueryToolDefinition,
} from '@plus-one/query';
import { REQUIRED_REPORTING_RELATIONS } from '@plus-one/reporting';
import { createAnalystSandboxTool } from '@plus-one/runtime';
import { createQueryTools } from './tools/query.js';

const maxRows = 500;
const maxOutputBytes = 128_000;
const statementTimeoutMs = 5_000;

type QueryToolDefinitionWithUserFacingFields = QueryToolDefinition & {
  userFacingFields: readonly string[];
};

const queryToolDefinitions: readonly QueryToolDefinitionWithUserFacingFields[] = [
  {
    toolName: 'account_list',
    relationNames: ['reporting.accounts'],
    sql: 'SELECT account_id, name FROM reporting.accounts WHERE household_id = $1 LIMIT 100',
    parameters: ['$1'],
    limit: 100,
    description: 'List household accounts.',
    userFacingFields: ['name'],
  },
  {
    toolName: 'current_balances',
    relationNames: ['reporting.current_balances'],
    sql: 'SELECT account_id, as_of, native_amount, native_currency, reporting_amount, reporting_currency, freshness_at FROM reporting.current_balances WHERE household_id = $1 LIMIT 100',
    parameters: ['$1'],
    limit: 100,
    description: 'Read current account balances.',
    userFacingFields: [
      'as_of',
      'native_amount',
      'native_currency',
      'reporting_amount',
      'reporting_currency',
      'freshness_at',
    ],
  },
  {
    toolName: 'categorized_transactions',
    relationNames: ['reporting.categorized_transactions'],
    sql: 'SELECT posting_id, journal_id, effective_on, account_id, account_name, accounting_class, direction, account_native_amount, account_native_currency, description FROM reporting.categorized_transactions WHERE household_id = $1 LIMIT 100',
    parameters: ['$1'],
    limit: 100,
    description: 'Read categorized transactions.',
    userFacingFields: [
      'effective_on',
      'account_name',
      'accounting_class',
      'direction',
      'account_native_amount',
      'account_native_currency',
      'description',
    ],
  },
  {
    toolName: 'category_spend_monthly',
    relationNames: ['reporting.category_spend_monthly'],
    sql: 'SELECT month_start, account_id, category_name, native_amount, native_currency FROM reporting.category_spend_monthly WHERE household_id = $1 LIMIT 100',
    parameters: ['$1'],
    limit: 100,
    description: 'Read monthly expense totals by category.',
    userFacingFields: ['month_start', 'category_name', 'native_amount', 'native_currency'],
  },
  {
    toolName: 'budget_variance',
    relationNames: ['reporting.budget_variance'],
    sql: 'SELECT scope_key, category_key, period_start, period_end, planned_amount, planned_currency, actual_amount FROM reporting.budget_variance WHERE household_id = $1 LIMIT 100',
    parameters: ['$1'],
    limit: 100,
    description: 'Read budget variance.',
    userFacingFields: [
      'scope_key',
      'category_key',
      'period_start',
      'period_end',
      'planned_amount',
      'planned_currency',
      'actual_amount',
    ],
  },
  {
    toolName: 'savings_goal_progress',
    relationNames: ['reporting.savings_goal_progress'],
    sql: 'SELECT goal_key, current_amount, target_amount, target_date FROM reporting.savings_goal_progress WHERE household_id = $1 LIMIT 100',
    parameters: ['$1'],
    limit: 100,
    description: 'Read savings goal progress.',
    userFacingFields: ['goal_key', 'current_amount', 'target_amount', 'target_date'],
  },
  {
    toolName: 'debt_progress',
    relationNames: ['reporting.debt_progress'],
    sql: 'SELECT debt_plan_key, name, account_id, lender_name, monthly_payment_amount, monthly_payment_currency, current_liability_amount, native_currency FROM reporting.debt_progress WHERE household_id = $1 LIMIT 100',
    parameters: ['$1'],
    limit: 100,
    description: 'Read debt progress.',
    userFacingFields: [
      'debt_plan_key',
      'name',
      'lender_name',
      'monthly_payment_amount',
      'monthly_payment_currency',
      'current_liability_amount',
      'native_currency',
    ],
  },
  {
    toolName: 'reconciliation_status',
    relationNames: ['reporting.reconciliation_status'],
    sql: 'SELECT statement_snapshot_id, account_id, period_start, period_end, opening_balance, closing_balance, currency, freshness_at FROM reporting.reconciliation_status WHERE household_id = $1 LIMIT 100',
    parameters: ['$1'],
    limit: 100,
    description: 'Read reconciliation status.',
    userFacingFields: [
      'period_start',
      'period_end',
      'opening_balance',
      'closing_balance',
      'currency',
      'freshness_at',
    ],
  },
  {
    toolName: 'source_freshness',
    relationNames: ['reporting.source_freshness'],
    sql: 'SELECT source_system, latest_source_at, source_document_count FROM reporting.source_freshness WHERE household_id = $1 LIMIT 100',
    parameters: ['$1'],
    limit: 100,
    description: 'Read source freshness.',
    userFacingFields: ['source_system', 'latest_source_at', 'source_document_count'],
  },
] as const;

export function isUserFacingQueryField(relationName: string, fieldName: string): boolean {
  return queryToolDefinitions.some((definition) =>
    definition.relationNames.includes(relationName) && definition.userFacingFields.includes(fieldName));
}

export function createDefaultQueryTools(pools: DatabasePools) {
  const validator = new ReadOnlySqlValidator();
  const registry = new QueryToolRegistry({
    allowedRelations: REQUIRED_REPORTING_RELATIONS,
    maxRows,
    validator,
  });
  for (const definition of queryToolDefinitions) {
    registry.register({
      toolName: definition.toolName,
      relationNames: definition.relationNames,
      sql: definition.sql,
      parameters: definition.parameters,
      limit: definition.limit,
      description: definition.description,
    });
  }

  return createQueryTools({
    registry,
    withEvidenceHandle: async (work) => {
      const runner = pgRunner(pools.query);
      const session = new EvidenceSession(runner, {
        allowedRelations: REQUIRED_REPORTING_RELATIONS,
        maxRows,
        maxOutputBytes,
        statementTimeoutMs,
        validator,
      }, registry);
      try {
        return await session.withSession(work);
      } finally {
        runner.release?.();
      }
    },
    analystSandboxTool: createAnalystSandboxTool(),
  });
}
