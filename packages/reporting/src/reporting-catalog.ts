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
  'reporting.cash_flow_monthly',
  'reporting.obligation_occurrences',
  'reporting.budget_variance',
  'reporting.savings_goal_progress',
  'reporting.debt_progress',
  'reporting.reconciliation_status',
  'reporting.source_freshness',
] as const;

type RelationName = typeof REQUIRED_REPORTING_RELATIONS[number];

const metadata = Object.fromEntries(REQUIRED_REPORTING_RELATIONS.map((relationName) => [
  relationName,
  {
    schemaName: 'reporting-relation-metadata',
    schemaVersion: 1,
    relationName,
    grain: relationName.endsWith('_daily') ? ['household', 'date'] : ['household'],
    metrics: ['amounts', 'counts', 'statuses'],
    householdScoped: true,
    currencyBehavior: 'Native amounts are preserved; reporting amounts use household reporting currency when derivable from posted facts.',
    freshness: relationName.includes('source') ? 'source freshness' : 'projection or ledger freshness',
    sourceSemantics: 'Rows are derived from authoritative accounting, ingestion, planning, and operations records; reporting rows are not source facts.',
  },
])) as Record<RelationName, ReportingRelationMetadataV1>;

export class ReportingCatalog {
  static staticMetadata(relationName: RelationName): ReportingRelationMetadataV1 {
    return ReportingRelationMetadataSchemaV1.parse(metadata[relationName]);
  }

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
