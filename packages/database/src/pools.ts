import { Pool, type PoolClient } from 'pg';
import { PlusOneError } from '@plus-one/contracts';
import type { DatabasePoolRole } from './config.js';
import { normalizeDatabaseError } from './errors.js';

export type DatabasePools = Record<DatabasePoolRole, Pool>;
const DEFAULT_POOL_OPTIONS = {
  allowExitOnIdle: true,
  idleTimeoutMillis: 30_000,
} as const;

export function createDatabasePools(poolUrls: Record<DatabasePoolRole, string>): DatabasePools {
  return {
    accounting: new Pool({ connectionString: poolUrls.accounting, max: 5, ...DEFAULT_POOL_OPTIONS }),
    planning: new Pool({ connectionString: poolUrls.planning, max: 5, ...DEFAULT_POOL_OPTIONS }),
    operations: new Pool({ connectionString: poolUrls.operations, max: 10, ...DEFAULT_POOL_OPTIONS }),
    query: new Pool({ connectionString: poolUrls.query, max: 5, ...DEFAULT_POOL_OPTIONS }),
    memory: new Pool({ connectionString: poolUrls.memory, max: 5, ...DEFAULT_POOL_OPTIONS }),
  };
}

export async function withDatabaseRole<T>(
  pools: DatabasePools,
  role: DatabasePoolRole,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pools[role].connect().catch((error: unknown) => {
    throw normalizeDatabaseError(error, { operation: `connect:${role}` });
  });

  try {
    return await callback(client);
  } catch (error) {
    throw normalizeDatabaseError(error, { operation: `role:${role}` });
  } finally {
    client.release();
  }
}

export async function verifyDatabasePools(pools: DatabasePools): Promise<void> {
  for (const role of Object.keys(pools) as DatabasePoolRole[]) {
    await withDatabaseRole(pools, role, async (client) => {
      const result = await client.query<{ current_user: string }>('SELECT current_user');
      const expected = `plus_one_${role}`;

      if (result.rows[0]?.current_user !== expected) {
        const actualUser = result.rows[0]?.current_user ?? 'no role';
        throw new PlusOneError({
          category: 'validation_rejected',
          code: 'database_role_mismatch',
          message: `Expected plus_one_${role}, received ${actualUser}`,
          retry: 'never',
          receiptLookupRequired: false,
          details: { role, actualUser },
        });
      }
    });
  }
}

export async function closeDatabasePools(pools: DatabasePools): Promise<void> {
  await Promise.all(Object.values(pools).map(async (pool) => pool.end()));
}
