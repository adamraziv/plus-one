import { describe, expect, it } from 'vitest';
import { ReportingRelationMetadataSchemaV1 } from '@plus-one/contracts';
import { REQUIRED_REPORTING_RELATIONS, ReportingCatalog } from './reporting-catalog.js';
import {
  ProjectionFinalizer,
  ProjectionHealthRepository,
  ProjectionRebuilder,
  ProjectionWriter,
} from './index.js';

describe('ReportingCatalog', () => {
  it('lists every V1 relation with grain, metrics, freshness, and source semantics', () => {
    expect(REQUIRED_REPORTING_RELATIONS).toEqual([
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
    ]);

    for (const relationName of REQUIRED_REPORTING_RELATIONS) {
      const metadata = ReportingRelationMetadataSchemaV1.parse(
        ReportingCatalog.staticMetadata(relationName),
      );
      expect(metadata.relationName).toBe(relationName);
      expect(metadata.grain.length).toBeGreaterThan(0);
      expect(metadata.metrics.length).toBeGreaterThan(0);
      expect(metadata.householdScoped).toBe(true);
      expect(metadata.freshness).toMatch(/projection|ledger|source|planning/);
      expect(metadata.sourceSemantics.length).toBeGreaterThan(0);
    }
  });
});

it('exports the Plan 09 public interfaces', () => {
  expect(ProjectionWriter).toBeTypeOf('function');
  expect(ProjectionFinalizer).toBeTypeOf('function');
  expect(ProjectionHealthRepository).toBeTypeOf('function');
  expect(ProjectionRebuilder).toBeTypeOf('function');
});
