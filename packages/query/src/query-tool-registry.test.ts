import { describe, expect, it } from 'vitest';
import type { QueryToolDefinition } from './query-tool-registry.js';
import { ReadOnlySqlValidator } from './sql-validator.js';
import { QueryToolRegistry } from './query-tool-registry.js';

const allowedRelations = [
  'reporting.accounts',
  'reporting.current_balances',
  'reporting.account_daily_balances',
  'reporting.household_net_worth_daily',
  'reporting.journal_activity',
  'reporting.categorized_transactions',
  'reporting.category_spend_monthly',
  'reporting.cash_flow_monthly',
  'reporting.obligation_occurrences',
  'reporting.budget_variance',
  'reporting.savings_goal_progress',
  'reporting.debt_progress',
  'reporting.reconciliation_status',
  'reporting.source_freshness',
];

function buildRegistry(): QueryToolRegistry {
  return new QueryToolRegistry({ allowedRelations, maxRows: 500, validator: new ReadOnlySqlValidator() });
}

describe('QueryToolRegistry', () => {
  it('registers every typed query tool over allowlisted reporting relations', () => {
    const registry = buildRegistry();
    const tools: QueryToolDefinition[] = [
      { toolName: 'account_list', relationNames: ['reporting.accounts'],
        sql: 'SELECT account_id, name FROM reporting.accounts WHERE household_id = $1 LIMIT 100',
        parameters: ['$1'], limit: 100, description: 'list accounts' },
      { toolName: 'current_balances', relationNames: ['reporting.current_balances'],
        sql: 'SELECT account_id, native_amount FROM reporting.current_balances WHERE household_id = $1 LIMIT 100',
        parameters: ['$1'], limit: 100, description: 'current balances' },
      { toolName: 'categorized_transactions', relationNames: ['reporting.categorized_transactions'],
        sql: 'SELECT posting_id, account_id, amount FROM reporting.categorized_transactions WHERE household_id = $1 LIMIT 100',
        parameters: ['$1'], limit: 100, description: 'categorized transactions' },
      { toolName: 'category_spend_monthly', relationNames: ['reporting.category_spend_monthly'],
        sql: 'SELECT month_start, category_name, native_amount FROM reporting.category_spend_monthly WHERE household_id = $1 LIMIT 100',
        parameters: ['$1'], limit: 100, description: 'category spend monthly' },
      { toolName: 'budget_variance', relationNames: ['reporting.budget_variance'],
        sql: 'SELECT planned_amount, actual_amount FROM reporting.budget_variance WHERE household_id = $1 LIMIT 100',
        parameters: ['$1'], limit: 100, description: 'budget variance' },
      { toolName: 'savings_goal_progress', relationNames: ['reporting.savings_goal_progress'],
        sql: 'SELECT goal_key, current_amount FROM reporting.savings_goal_progress WHERE household_id = $1 LIMIT 100',
        parameters: ['$1'], limit: 100, description: 'savings goals' },
      { toolName: 'debt_progress', relationNames: ['reporting.debt_progress'],
        sql: 'SELECT debt_plan_key, current_liability_amount FROM reporting.debt_progress WHERE household_id = $1 LIMIT 100',
        parameters: ['$1'], limit: 100, description: 'debt progress' },
      { toolName: 'reconciliation_status', relationNames: ['reporting.reconciliation_status'],
        sql: 'SELECT statement_snapshot_id, opening_balance FROM reporting.reconciliation_status WHERE household_id = $1 LIMIT 100',
        parameters: ['$1'], limit: 100, description: 'reconciliation status' },
      { toolName: 'source_freshness', relationNames: ['reporting.source_freshness'],
        sql: 'SELECT source_system, latest_source_at FROM reporting.source_freshness WHERE household_id = $1 LIMIT 100',
        parameters: ['$1'], limit: 100, description: 'source freshness' },
    ];

    for (const tool of tools) registry.register(tool);

    const names = registry.list().map((entry) => entry.toolName);
    expect(names).toEqual([
      'account_list', 'budget_variance', 'categorized_transactions',
      'category_spend_monthly',
      'current_balances', 'debt_progress', 'reconciliation_status',
      'savings_goal_progress', 'source_freshness',
    ]);
    expect(registry.get('current_balances').relationNames)
      .toEqual(['reporting.current_balances']);
  });

  it('rejects a tool that targets a non-allowlisted relation', () => {
    const registry = buildRegistry();
    expect(() => registry.register({
      toolName: 'forbidden',
      relationNames: ['accounting.accounts'],
      sql: 'SELECT account_id FROM accounting.accounts WHERE household_id = $1 LIMIT 1',
      parameters: ['$1'],
      limit: 1,
      description: 'forbidden tool',
    })).toThrow();
  });

  it('rejects a tool whose limit exceeds the registry maxRows', () => {
    const registry = buildRegistry();
    expect(() => registry.register({
      toolName: 'too_large',
      relationNames: ['reporting.accounts'],
      sql: 'SELECT account_id FROM reporting.accounts WHERE household_id = $1 LIMIT 501',
      parameters: ['$1'],
      limit: 501,
      description: 'too large',
    })).toThrow();
  });

  it('rejects unknown tool lookups', () => {
    const registry = buildRegistry();
    expect(() => registry.get('not_registered')).toThrow(/Unknown query tool/);
  });
});
