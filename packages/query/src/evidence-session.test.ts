import { describe, expect, it } from 'vitest';
import {
  EvidenceSession, type QueryRunner,
} from './evidence-session.js';
import { QueryToolRegistry } from './query-tool-registry.js';
import { ReadOnlySqlValidator } from './sql-validator.js';
import {
  EvidenceRequestSchemaV1, type QuerySpecificationV1,
} from '@plus-one/contracts';

const allowedRelations = [
  'reporting.accounts',
  'reporting.account_current_balances',
  'reporting.categorized_transactions',
  'reporting.cash_flow_monthly',
  'reporting.source_freshness',
];

function buildToolRegistry(): QueryToolRegistry {
  return new QueryToolRegistry({
    allowedRelations,
    maxRows: 500,
    validator: new ReadOnlySqlValidator(),
  });
}

function buildSessionConfig(): { session: EvidenceSession; tools: QueryToolRegistry } {
  const tools = buildToolRegistry();
  tools.register({
    toolName: 'account_list',
    relationNames: ['reporting.accounts'],
    sql: 'SELECT account_id, name FROM reporting.accounts WHERE household_id = $1 LIMIT 100',
    parameters: ['$1'],
    limit: 100,
    description: 'list accounts',
  });
  tools.register({
    toolName: 'source_freshness',
    relationNames: ['reporting.source_freshness'],
    sql: 'SELECT source_system FROM reporting.source_freshness WHERE household_id = $1 LIMIT 100',
    parameters: ['$1'],
    limit: 100,
    description: 'source freshness',
  });
  const runner: QueryRunner = {
    async query<R extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
    ): Promise<{ rows: readonly R[] }> {
      if (text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') {
        return { rows: [] };
      }
      if (text.startsWith('SET LOCAL statement_timeout')) {
        return { rows: [] };
      }
      if (text === 'COMMIT') return { rows: [] };
      if (text === 'ROLLBACK') return { rows: [] };
      return { rows: [{ account_id: 1, name: 'Cash' } as unknown as R] };
    },
  };
  const session = new EvidenceSession(runner, {
    allowedRelations,
    maxRows: 500,
    maxOutputBytes: 1_000_000,
    statementTimeoutMs: 5_000,
    validator: new ReadOnlySqlValidator(),
  }, tools);
  return { session, tools };
}

const sampleRequest = EvidenceRequestSchemaV1.parse({
  schemaName: 'evidence-request',
  schemaVersion: 1,
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  requestId: 'evidence_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  businessQuestion: 'How many accounts?',
  intendedUse: 'reporting-review',
  timeframe: { start: '2026-06-01', end: '2026-06-30' },
  desiredGrain: ['household', 'account'],
  filters: [],
  requiredFreshness: 'ledger freshness',
  requiredCalculations: ['count accounts'],
  coverage: ['reporting.accounts'],
});

const sampleFlexibleSpec: QuerySpecificationV1 = {
  schemaName: 'query-specification',
  schemaVersion: 1,
  relationNames: ['reporting.accounts'],
  sql: "SELECT account_id, name FROM reporting.accounts WHERE household_id = 1 LIMIT 5",
  filters: [],
  limit: 5,
};

describe('EvidenceSession', () => {
  it('opens a repeatable-read read-only transaction and runs a typed tool', async () => {
    const { session } = buildSessionConfig();
    const result = await session.withSession(async (handle) => handle.runTool('account_list', [1]));
    expect(result.relationName).toBe('reporting.accounts');
    expect(result.rows).toEqual([{ account_id: 1, name: 'Cash' }]);
    expect(result.fieldDefinitions).toEqual(['account_id', 'name']);
  });

  it('rejects tool calls with the wrong parameter arity', async () => {
    const { session } = buildSessionConfig();
    await expect(session.withSession(async (handle) => handle.runTool('account_list', [])))
      .rejects.toThrow(/expects 1 parameter/);
  });

  it('runs a flexible specification and assembles a schema-valid evidence package', async () => {
    const { session } = buildSessionConfig();
    const evidencePackage = await session.withSession(async (handle) => handle.buildEvidencePackage({
      request: sampleRequest,
      querySpecification: sampleFlexibleSpec,
    }));
    expect(evidencePackage.schemaName).toBe('evidence-package');
    expect(evidencePackage.queryResults[0]?.relationName).toBe('reporting.accounts');
    expect(evidencePackage.evidencePackageId).toBe(sampleRequest.requestId);
  });

  it('rejects flexible SQL targeting more than one relation', async () => {
    const { session } = buildSessionConfig();
    const spec: QuerySpecificationV1 = {
      ...sampleFlexibleSpec,
      sql: 'SELECT a.account_id FROM reporting.accounts a JOIN reporting.source_freshness f ON f.household_id = a.household_id WHERE a.household_id = 1 LIMIT 5',
      relationNames: ['reporting.accounts', 'reporting.source_freshness'],
    };
    await expect(session.withSession(async (handle) => handle.runFlexibleQuery(spec)))
      .rejects.toThrow(/Query SQL was rejected|relation/);
  });

  it('rejects a row-count over the limit', async () => {
    const runner: QueryRunner = {
      async query<R extends Record<string, unknown>>(text: string): Promise<{ rows: readonly R[] }> {
        if (text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' || text === 'COMMIT'
          || text === 'ROLLBACK' || text.startsWith('SET LOCAL statement_timeout')) {
          return { rows: [] };
        }
        return { rows: Array.from({ length: 6 }, (_, i) => ({ account_id: i } as unknown as R)) };
      },
    };
    const tools = buildToolRegistry();
    tools.register({
      toolName: 'account_list',
      relationNames: ['reporting.accounts'],
      sql: 'SELECT account_id FROM reporting.accounts WHERE household_id = $1 LIMIT 5',
      parameters: ['$1'],
      limit: 5,
      description: 'list accounts',
    });
    const session = new EvidenceSession(runner, {
      allowedRelations,
      maxRows: 500,
      maxOutputBytes: 1_000_000,
      statementTimeoutMs: 5_000,
      validator: new ReadOnlySqlValidator(),
    }, tools);
    await expect(session.withSession(async (handle) => handle.runTool('account_list', [1])))
      .rejects.toThrow(/limit/i);
  });

  it('rolls back the transaction when a tool throws', async () => {
    let sawRollback = false;
    const runner: QueryRunner = {
      async query<R extends Record<string, unknown>>(text: string): Promise<{ rows: readonly R[] }> {
        if (text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' || text === 'COMMIT') {
          return { rows: [] };
        }
        if (text === 'ROLLBACK') { sawRollback = true; return { rows: [] }; }
        if (text.startsWith('SET LOCAL statement_timeout')) return { rows: [] };
        throw new Error('boom');
      },
    };
    const tools = buildToolRegistry();
    tools.register({
      toolName: 'source_freshness',
      relationNames: ['reporting.source_freshness'],
      sql: 'SELECT source_system FROM reporting.source_freshness WHERE household_id = $1 LIMIT 100',
      parameters: ['$1'],
      limit: 100,
      description: 'source freshness',
    });
    const session = new EvidenceSession(runner, {
      allowedRelations,
      maxRows: 500,
      maxOutputBytes: 1_000_000,
      statementTimeoutMs: 5_000,
      validator: new ReadOnlySqlValidator(),
    }, tools);
    await expect(session.withSession(async (handle) => handle.runTool('source_freshness', [1])))
      .rejects.toThrow(/boom/);
    expect(sawRollback).toBe(true);
  });
});
