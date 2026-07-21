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
  it('uses reporting relation metadata returned by the database', async () => {
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

    const catalog = new ReportingCatalog();
    const metadata = await catalog.list({
      query: async () => ({ rows: [
        {
          schemaName: 'reporting-relation-metadata', schemaVersion: 1,
          relationName: 'reporting.categorized_transactions', grain: ['household', 'posting'],
          metrics: ['categorized amounts'], householdScoped: true,
          currencyBehavior: 'Account native currency.', freshness: 'ledger freshness',
          sourceSemantics: 'Derived from posted postings and accounts.',
        },
      ] }),
    } as never);

    expect(ReportingRelationMetadataSchemaV1.parse(metadata[0])).toMatchObject({
      relationName: 'reporting.categorized_transactions',
      grain: ['household', 'posting'],
    });
  });
});

it('exports the Plan 09 public interfaces', () => {
  expect(ProjectionWriter).toBeTypeOf('function');
  expect(ProjectionFinalizer).toBeTypeOf('function');
  expect(ProjectionHealthRepository).toBeTypeOf('function');
  expect(ProjectionRebuilder).toBeTypeOf('function');
});
