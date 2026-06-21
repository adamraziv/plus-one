import { describe, expect, it } from 'vitest';
import {
  EvidencePackageSchemaV1,
  EvidenceRequestSchemaV1,
  QueryResultSchemaV1,
} from './contracts.js';

describe('query evidence contracts', () => {
  it('requires a bounded evidence request with business intent and freshness', () => {
    expect(EvidenceRequestSchemaV1.parse({
      schemaName: 'evidence-request',
      schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      requestId: 'evidence_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      businessQuestion: 'How much did we spend on groceries in June?',
      intendedUse: 'cash-flow-review',
      timeframe: { start: '2026-06-01', end: '2026-06-30' },
      desiredGrain: ['month', 'category'],
      filters: [{ field: 'category', op: 'eq', value: 'groceries' }],
      requiredFreshness: 'projection freshness_at within 1 day',
      requiredCalculations: ['sum expense postings'],
      coverage: ['posted ledger facts only'],
    }).requestId).toBe('evidence_01JNZQ4A9B8C7D6E5F4G3H2J1K');
  });

  it('requires query results to name relation metadata and source freshness', () => {
    expect(QueryResultSchemaV1.safeParse({
      schemaName: 'query-result',
      schemaVersion: 1,
      relationName: 'accounting.postings',
      rows: [],
    }).success).toBe(false);
  });

  it('requires verified evidence packages to carry checked query output', () => {
    expect(EvidencePackageSchemaV1.safeParse({
      schemaName: 'evidence-package',
      schemaVersion: 1,
      status: 'verified',
      queryResults: [],
    }).success).toBe(false);
  });
});
