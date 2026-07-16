import { describe, expect, it } from 'vitest';
import {
  EvidenceSession, type QueryRunner,
} from './evidence-session.js';
import { QueryToolRegistry } from './query-tool-registry.js';
import { ReadOnlySqlValidator } from './sql-validator.js';
import {
  ArtifactIdSchema,
  EvidenceRequestSchemaV1,
  type QuerySpecificationV1,
} from '@plus-one/contracts';

const allowedRelations = [
  'reporting.accounts',
  'reporting.current_balances',
  'reporting.categorized_transactions',
  'reporting.cash_flow_monthly',
  'reporting.source_freshness',
];

const reportingGrains: Record<string, readonly string[]> = {
  'reporting.accounts': ['household', 'account'],
  'reporting.current_balances': ['household', 'account'],
  'reporting.categorized_transactions': ['household', 'posting'],
  'reporting.cash_flow_monthly': ['household', 'month', 'accounting class', 'currency'],
  'reporting.source_freshness': ['household', 'source system'],
};

function reportingMetadataResponse<R extends Record<string, unknown>>(
  text: string,
  values?: readonly unknown[],
): { rows: readonly R[] } | undefined {
  if (!text.includes('FROM reporting.relation_metadata')) return undefined;
  const relationName = values?.[0];
  const grain = typeof relationName === 'string' ? reportingGrains[relationName] : undefined;
  return { rows: grain === undefined ? [] : [{ grain } as unknown as R] };
}

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
      values?: readonly unknown[],
    ): Promise<{ rows: readonly R[] }> {
      if (text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') {
        return { rows: [] };
      }
      if (text.startsWith('SET LOCAL statement_timeout')) {
        return { rows: [] };
      }
      if (text === 'COMMIT') return { rows: [] };
      if (text === 'ROLLBACK') return { rows: [] };
      const metadata = reportingMetadataResponse<R>(text, values);
      if (metadata !== undefined) return metadata;
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

const sampleArtifactId = ArtifactIdSchema.parse('artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K');

describe('EvidenceSession', () => {
  it('opens a repeatable-read read-only transaction and runs a typed tool', async () => {
    const { session } = buildSessionConfig();
    const result = await session.withSession(async (handle) =>
      handle.runTool('account_list', ['hh_01JNZQ4A9B8C7D6E5F4G3H2J1K']));
    expect(result.relationName).toBe('reporting.accounts');
    expect(result.rows).toEqual([{ account_id: 1, name: 'Cash' }]);
    expect(result.fieldDefinitions).toEqual(['account_id', 'name']);
    expect(result.sourceReferences).toEqual([
      'relation=reporting.accounts',
      'filter=household_id:eq:hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    ]);
  });

  it('uses the reporting metadata grain instead of a duplicated application map', async () => {
    const tools = buildToolRegistry();
    tools.register({
      toolName: 'categorized_transactions',
      relationNames: ['reporting.categorized_transactions'],
      sql: 'SELECT posting_id, journal_id, account_id FROM reporting.categorized_transactions WHERE household_id = $1 LIMIT 100',
      parameters: ['$1'],
      limit: 100,
      description: 'categorized transactions',
    });
    const runner = {
      async query<R extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        values?: readonly unknown[],
      ) {
        if (text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') return { rows: [] as readonly R[] };
        if (text.startsWith('SET LOCAL statement_timeout')) return { rows: [] as readonly R[] };
        if (text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] as readonly R[] };
        const metadata = reportingMetadataResponse<R>(text, values);
        if (metadata !== undefined) return metadata;
        return {
          rows: [] as readonly R[],
          fields: [{ name: 'posting_id' }, { name: 'journal_id' }, { name: 'account_id' }],
        };
      },
    };
    const session = new EvidenceSession(runner, {
      allowedRelations,
      maxRows: 500,
      maxOutputBytes: 1_000_000,
      statementTimeoutMs: 5_000,
      validator: new ReadOnlySqlValidator(),
    }, tools);

    const result = await session.withSession(async (handle) =>
      handle.runTool('categorized_transactions', ['hh_01JNZQ4A9B8C7D6E5F4G3H2J1K']));

    expect(result.grain).toEqual(['household', 'posting']);
  });

  it('keeps field definitions when a typed tool returns zero rows', async () => {
    const tools = buildToolRegistry();
    tools.register({
      toolName: 'account_list',
      relationNames: ['reporting.accounts'],
      sql: 'SELECT account_id, name FROM reporting.accounts WHERE household_id = $1 LIMIT 100',
      parameters: ['$1'],
      limit: 100,
      description: 'list accounts',
    });
    const runner = {
      async query<R extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        values?: readonly unknown[],
      ) {
        if (text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') return { rows: [] as readonly R[] };
        if (text.startsWith('SET LOCAL statement_timeout')) return { rows: [] as readonly R[] };
        if (text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] as readonly R[] };
        const metadata = reportingMetadataResponse<R>(text, values);
        if (metadata !== undefined) return metadata;
        return {
          rows: [] as readonly R[],
          fields: [{ name: 'account_id' }, { name: 'name' }],
        };
      },
    } as QueryRunner;
    const session = new EvidenceSession(runner, {
      allowedRelations,
      maxRows: 500,
      maxOutputBytes: 1_000_000,
      statementTimeoutMs: 5_000,
      validator: new ReadOnlySqlValidator(),
    }, tools);

    const result = await session.withSession(async (handle) =>
      handle.runTool('account_list', ['hh_01JNZQ4A9B8C7D6E5F4G3H2J1K']));

    expect(result.rows).toEqual([]);
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
      analyst: {
        task: {
          schemaName: 'analyst-task',
          schemaVersion: 1,
          evidencePackageId: sampleRequest.requestId,
          request: sampleRequest,
          queryResult: {
            schemaName: 'query-result',
            schemaVersion: 1,
            relationName: 'reporting.accounts',
            grain: ['household', 'account'],
            rows: [{ account_id: 1, name: 'Cash' }],
            fieldDefinitions: ['account_id', 'name'],
            sourceReferences: ['relation=reporting.accounts'],
            freshness: 'ledger freshness',
            coverageWarnings: [],
          },
        },
        result: {
          schemaName: 'analyst-calculation-artifact',
          schemaVersion: 1,
          pythonSource: 'result = {"count": 1}',
          inputPayload: { rows: [{ account_id: 1 }] },
          stdout: '',
          stderr: '',
          exitCode: 0,
          result: { count: 1 },
          calculations: ['count rows'],
          assumptions: [],
          interpretation: 'One account exists.',
        },
        makerArtifactId: sampleArtifactId,
        checkerArtifactId: sampleArtifactId,
        checkerOutput: {
          schemaName: 'analyst-checker-output',
          schemaVersion: 1,
          accepted: true,
          checkedAnalystArtifactId: sampleArtifactId,
          findings: [],
        },
      },
    }));
    expect(evidencePackage.schemaName).toBe('evidence-package');
    expect(evidencePackage.queryResults[0]?.relationName).toBe('reporting.accounts');
    expect(evidencePackage.evidencePackageId).toBe(sampleRequest.requestId);
    expect(evidencePackage.analyst?.result.result).toEqual({ count: 1 });
  });

  it('rejects an evidence package when its request grain conflicts with reporting metadata', async () => {
    const { session } = buildSessionConfig();
    const request = EvidenceRequestSchemaV1.parse({
      ...sampleRequest,
      desiredGrain: ['category'],
      requiredCalculations: [],
    });

    await expect(session.withSession(async (handle) => handle.buildEvidencePackage({
      request,
      querySpecification: sampleFlexibleSpec,
    }))).rejects.toMatchObject({ code: 'evidence_package_grain_mismatch' });
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
      async query<R extends Record<string, unknown>>(
        text: string,
        values?: readonly unknown[],
      ): Promise<{ rows: readonly R[] }> {
        if (text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' || text === 'COMMIT'
          || text === 'ROLLBACK' || text.startsWith('SET LOCAL statement_timeout')) {
          return { rows: [] };
        }
        const metadata = reportingMetadataResponse<R>(text, values);
        if (metadata !== undefined) return metadata;
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
      async query<R extends Record<string, unknown>>(
        text: string,
        values?: readonly unknown[],
      ): Promise<{ rows: readonly R[] }> {
        if (text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' || text === 'COMMIT') {
          return { rows: [] };
        }
        if (text === 'ROLLBACK') { sawRollback = true; return { rows: [] }; }
        if (text.startsWith('SET LOCAL statement_timeout')) return { rows: [] };
        const metadata = reportingMetadataResponse<R>(text, values);
        if (metadata !== undefined) return metadata;
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
