interface QueryCoverageRoute {
  relationName: string;
  toolName: string;
}

const routes: Readonly<Record<string, QueryCoverageRoute>> = {
  'account list': { relationName: 'reporting.accounts', toolName: 'account_list' },
  'reporting.accounts': { relationName: 'reporting.accounts', toolName: 'account_list' },
  'balance snapshot': { relationName: 'reporting.current_balances', toolName: 'current_balances' },
  'reporting.current_balances': { relationName: 'reporting.current_balances', toolName: 'current_balances' },
  'reporting.account_current_balances': { relationName: 'reporting.current_balances', toolName: 'current_balances' },
  'categorized transactions': { relationName: 'reporting.categorized_transactions', toolName: 'categorized_transactions' },
  'reporting.categorized_transactions': { relationName: 'reporting.categorized_transactions', toolName: 'categorized_transactions' },
  'category spend monthly': { relationName: 'reporting.category_spend_monthly', toolName: 'category_spend_monthly' },
  'reporting.category_spend_monthly': { relationName: 'reporting.category_spend_monthly', toolName: 'category_spend_monthly' },
  'budget variance': { relationName: 'reporting.budget_variance', toolName: 'budget_variance' },
  'reporting.budget_variance': { relationName: 'reporting.budget_variance', toolName: 'budget_variance' },
  'savings goal progress': { relationName: 'reporting.savings_goal_progress', toolName: 'savings_goal_progress' },
  'reporting.savings_goal_progress': { relationName: 'reporting.savings_goal_progress', toolName: 'savings_goal_progress' },
  'debt progress': { relationName: 'reporting.debt_progress', toolName: 'debt_progress' },
  'reporting.debt_progress': { relationName: 'reporting.debt_progress', toolName: 'debt_progress' },
  'reconciliation status': { relationName: 'reporting.reconciliation_status', toolName: 'reconciliation_status' },
  'reporting.reconciliation_status': { relationName: 'reporting.reconciliation_status', toolName: 'reconciliation_status' },
  'source freshness': { relationName: 'reporting.source_freshness', toolName: 'source_freshness' },
  'reporting.source_freshness': { relationName: 'reporting.source_freshness', toolName: 'source_freshness' },
};

export function queryCoverageRoute(coverage: readonly string[]): QueryCoverageRoute | undefined {
  const resolved = coverage.map((value) => routes[value]);
  if (resolved.length === 0 || resolved.some((route) => route === undefined)) return undefined;
  const [first] = resolved;
  if (first === undefined || resolved.some((route) =>
    route?.relationName !== first.relationName || route?.toolName !== first.toolName)) {
    return undefined;
  }
  return first;
}

export function queryRelationForCoverage(coverage: readonly string[]): string | undefined {
  return queryCoverageRoute(coverage)?.relationName;
}

export function queryToolNameForCoverage(coverage: readonly string[]): string | undefined {
  return queryCoverageRoute(coverage)?.toolName;
}
