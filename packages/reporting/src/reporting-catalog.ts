import type { PoolClient } from 'pg';
import {
  ReportingRelationMetadataSchemaV1,
  type ReportingRelationMetadataV1,
} from '@plus-one/contracts';

export const REQUIRED_REPORTING_RELATIONS = [
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
] as const;

export class ReportingCatalog {
  async list(client: Pick<PoolClient, 'query'>): Promise<ReportingRelationMetadataV1[]> {
    const result = await client.query<ReportingRelationMetadataV1>(
      `SELECT 'reporting-relation-metadata' AS "schemaName", 1 AS "schemaVersion",
        relation_name AS "relationName", grain, metrics, household_scoped AS "householdScoped",
        currency_behavior AS "currencyBehavior", freshness, source_semantics AS "sourceSemantics"
       FROM reporting.relation_metadata
       ORDER BY relation_name`,
    );
    return result.rows.map((row) => ReportingRelationMetadataSchemaV1.parse(row));
  }
}
