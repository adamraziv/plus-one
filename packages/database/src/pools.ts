import { Pool, type PoolClient } from 'pg';
import type { DatabasePoolRole } from './config.js';
import { normalizeDatabaseError } from './errors.js';

export type DatabasePools = Record<DatabasePoolRole, Pool>;

export function createDatabasePools(poolUrls: Record<DatabasePoolRole, string>): DatabasePools {
  return {
    accounting: new Pool({ connectionString: poolUrls.accounting, max: 5, idleTimeoutMillis: 30_000 }),
    planning: new Pool({ connectionString: poolUrls.planning, max: 5, idleTimeoutMillis: 30_000 }),
    operations: new Pool({ connectionString: poolUrls.operations, max: 10, idleTimeoutMillis: 30_000 }),
    query: new Pool({ connectionString: poolUrls.query, max: 5, idleTimeoutMillis: 30_000 }),
    memory: new Pool({ connectionString: poolUrls.memory, max: 5, idleTimeoutMillis: 30_000 }),
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
        throw new PlusOneDatabaseRoleError(role, result.rows[0]?.current_user);
      }
    });
  }
}

class PlusOneDatabaseRoleError extends Error {
  constructor(expectedRole: DatabasePoolRole, actualRole: string | undefined) {
    super(`Expected plus_one_${expectedRole}, received ${actualRole ?? 'no role'}`);
    this.name = 'PlusOneDatabaseRoleError';
  }
}

export async function closeDatabasePools(pools: DatabasePools): Promise<void> {
  await Promise.all(Object.values(pools).map(async (pool) => pool.end()));
}
