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
import type { RoleAgentTools } from './mastra/role-agent.js';
import { createQueryTools } from './tools/query.js';

const maxRows = 500;
const maxOutputBytes = 128_000;
const statementTimeoutMs = 5_000;

const queryToolDefinitions: readonly QueryToolDefinition[] = [
  {
    toolName: 'account_list',
    relationNames: ['reporting.accounts'],
    sql: 'SELECT account_id, name FROM reporting.accounts WHERE household_id = $1 LIMIT 100',
    parameters: ['$1'],
    limit: 100,
    description: 'List household accounts.',
  },
  {
    toolName: 'current_balances',
    relationNames: ['reporting.account_current_balances'],
    sql: 'SELECT account_id, native_amount, reporting_amount, as_of FROM reporting.account_current_balances WHERE household_id = $1 LIMIT 100',
    parameters: ['$1'],
    limit: 100,
    description: 'Read current account balances.',
  },
  {
    toolName: 'categorized_transactions',
    relationNames: ['reporting.categorized_transactions'],
    sql: 'SELECT posting_id, account_id, amount, category, posted_at FROM reporting.categorized_transactions WHERE household_id = $1 LIMIT 100',
    parameters: ['$1'],
    limit: 100,
    description: 'Read categorized transactions.',
  },
  {
    toolName: 'budget_variance',
    relationNames: ['reporting.budget_variance'],
    sql: 'SELECT budget_key, category, planned_amount, actual_amount, variance_amount FROM reporting.budget_variance WHERE household_id = $1 LIMIT 100',
    parameters: ['$1'],
    limit: 100,
    description: 'Read budget variance.',
  },
  {
    toolName: 'savings_goal_progress',
    relationNames: ['reporting.savings_goal_progress'],
    sql: 'SELECT goal_key, current_amount, target_amount, target_date FROM reporting.savings_goal_progress WHERE household_id = $1 LIMIT 100',
    parameters: ['$1'],
    limit: 100,
    description: 'Read savings goal progress.',
  },
  {
    toolName: 'debt_progress',
    relationNames: ['reporting.debt_progress'],
    sql: 'SELECT debt_plan_key, current_liability_amount, target_liability_amount, target_date FROM reporting.debt_progress WHERE household_id = $1 LIMIT 100',
    parameters: ['$1'],
    limit: 100,
    description: 'Read debt progress.',
  },
  {
    toolName: 'reconciliation_status',
    relationNames: ['reporting.reconciliation_status'],
    sql: 'SELECT statement_snapshot_id, account_id, statement_ending_balance, ledger_ending_balance, reconciliation_status FROM reporting.reconciliation_status WHERE household_id = $1 LIMIT 100',
    parameters: ['$1'],
    limit: 100,
    description: 'Read reconciliation status.',
  },
  {
    toolName: 'source_freshness',
    relationNames: ['reporting.source_freshness'],
    sql: 'SELECT source_system, latest_source_at, latest_import_batch_id FROM reporting.source_freshness WHERE household_id = $1 LIMIT 100',
    parameters: ['$1'],
    limit: 100,
    description: 'Read source freshness.',
  },
] as const;

export function createDefaultQueryTools(pools: DatabasePools): RoleAgentTools {
  const validator = new ReadOnlySqlValidator();
  const registry = new QueryToolRegistry({
    allowedRelations: REQUIRED_REPORTING_RELATIONS,
    maxRows,
    validator,
  });
  for (const definition of queryToolDefinitions) registry.register(definition);

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
