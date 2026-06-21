import { afterEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
  EvidenceRequestSchemaV1, type QuerySpecificationV1,
} from '@plus-one/contracts';
import {
  EvidenceSession, QueryToolRegistry, ReadOnlySqlValidator, pgRunner,
  type QueryRunner,
} from '@plus-one/query';
import { REQUIRED_REPORTING_RELATIONS } from '@plus-one/reporting';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';
import { id } from '../helpers/accounting-ledger.js';

let context: PostgresTestContext | undefined;
let owner: Pool | undefined;
let queryPool: Pool | undefined;
let runner: QueryRunner | undefined;
let client: PoolClient | undefined;

afterEach(async () => {
  runner?.release?.();
  try {
    client?.release();
  } catch { /* ignore */ }
  if (queryPool !== undefined) {
    await queryPool.end().catch(() => undefined);
  }
  if (owner !== undefined) {
    await owner.end().catch(() => undefined);
  }
  if (context !== undefined) {
    await context.cleanup().catch(() => undefined);
  }
  client = undefined;
  runner = undefined;
  queryPool = undefined;
  owner = undefined;
  context = undefined;
});

async function seedReportingAccounts(ownerPool: Pool): Promise<{
  householdDbId: string;
  householdId: string;
  accountId: string;
}> {
  const householdId = id('hh', 200);
  const accountId = id('account', 200);
  const bookId = id('book', 200);
  const bookConfigId = id('bookconfig', 200);
  const household = await ownerPool.query<{ id: string }>(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1,'USD','UTC') RETURNING id::text`,
    [householdId],
  );
  const householdDbId = household.rows[0]!.id;
  const book = await ownerPool.query<{ id: string }>(
    `INSERT INTO accounting.books (book_id, household_id, name)
     VALUES ($1,$2,'Household Book') RETURNING id::text`,
    [bookId, householdDbId],
  );
  const bookDbId = book.rows[0]!.id;
  await ownerPool.query(
    `INSERT INTO accounting.book_configurations
     (configuration_id, household_id, book_id, reporting_currency, effective_from)
     VALUES ($1,$2,$3,'USD',DATE '2026-01-01')`,
    [bookConfigId, householdDbId, bookDbId],
  );
  await ownerPool.query(
    `INSERT INTO accounting.accounts
     (account_id, household_id, book_id, name, accounting_class, normal_balance, native_currency)
     VALUES ($1,$2,$3,'Cash','asset','debit','USD')`,
    [accountId, householdDbId, bookDbId],
  );
  return { householdDbId, householdId, accountId };
}

function buildSession(queryPoolRef: Pool): {
  session: EvidenceSession;
  runner: QueryRunner;
  tools: QueryToolRegistry;
} {
  const tools = new QueryToolRegistry({
    allowedRelations: REQUIRED_REPORTING_RELATIONS,
    maxRows: 500,
    validator: new ReadOnlySqlValidator(),
  });
  tools.register({
    toolName: 'account_list',
    relationNames: ['reporting.accounts'],
    sql: `SELECT account_id, name FROM reporting.accounts WHERE household_id = $1 LIMIT 100`,
    parameters: ['$1'],
    limit: 100,
    description: 'list accounts',
  });
  const localRunner = pgRunner(queryPoolRef);
  const session = new EvidenceSession(localRunner, {
    allowedRelations: REQUIRED_REPORTING_RELATIONS,
    maxRows: 500,
    maxOutputBytes: 1_000_000,
    statementTimeoutMs: 5_000,
    validator: new ReadOnlySqlValidator(),
  }, tools);
  return { session, runner: localRunner, tools };
}

describe('evidence session', () => {
  it('runs two reads in one repeatable-read read-only snapshot via the query pool', async () => {
    context = await createPostgresTestContext('evidence_session');
    owner = new Pool({ connectionString: context.migratorUrl });
    queryPool = new Pool({ connectionString: context.roleUrls.query });
    const seeded = await seedReportingAccounts(owner);
    const { session, runner: r } = buildSession(queryPool);
    runner = r;

    const firstRead = await session.withSession(async (handle) => handle.runTool('account_list', [seeded.householdId]));
    expect(firstRead.relationName).toBe('reporting.accounts');
    expect(firstRead.rows).toEqual([{ account_id: seeded.accountId, name: 'Cash' }]);
  });

  it('rejects a flexible query that exceeds the row limit', async () => {
    context = await createPostgresTestContext('evidence_session_limit');
    owner = new Pool({ connectionString: context.migratorUrl });
    queryPool = new Pool({ connectionString: context.roleUrls.query });
    const { session, runner: r } = buildSession(queryPool);
    runner = r;

    const oversized: QuerySpecificationV1 = {
      schemaName: 'query-specification',
      schemaVersion: 1,
      relationNames: ['reporting.accounts'],
      sql: 'SELECT account_id FROM reporting.accounts LIMIT 501',
      filters: [],
      limit: 501,
    };
    await expect(session.withSession(async (handle) => handle.runFlexibleQuery(oversized)))
      .rejects.toThrow(/Query SQL was rejected/);
  });

  it('returns a schema-valid evidence package from a repeatable-read session', async () => {
    context = await createPostgresTestContext('evidence_session_package');
    owner = new Pool({ connectionString: context.migratorUrl });
    queryPool = new Pool({ connectionString: context.roleUrls.query });
    const seeded = await seedReportingAccounts(owner);
    const { session, runner: r } = buildSession(queryPool);
    runner = r;

    const request = EvidenceRequestSchemaV1.parse({
      schemaName: 'evidence-request',
      schemaVersion: 1,
      householdId: seeded.householdId,
      requestId: id('evidence', 200),
      businessQuestion: 'list accounts?',
      intendedUse: 'reporting-review',
      timeframe: { start: '2026-06-01', end: '2026-06-30' },
      desiredGrain: ['household', 'account'],
      filters: [],
      requiredFreshness: 'ledger freshness',
      requiredCalculations: ['count accounts'],
      coverage: ['reporting.accounts'],
    });
    const spec: QuerySpecificationV1 = {
      schemaName: 'query-specification',
      schemaVersion: 1,
      relationNames: ['reporting.accounts'],
      sql: `SELECT account_id, name FROM reporting.accounts WHERE household_id = '${seeded.householdId}' LIMIT 5`,
      filters: [],
      limit: 5,
    };
    const evidencePackage = await session.withSession(async (handle) => handle.buildEvidencePackage({
      request,
      querySpecification: spec,
    }));
    expect(evidencePackage.schemaName).toBe('evidence-package');
    expect(evidencePackage.queryResults).toHaveLength(1);
    expect(evidencePackage.queryResults[0]?.rows.length).toBeGreaterThan(0);
  });
});
