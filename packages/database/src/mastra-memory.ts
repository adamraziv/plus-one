import { MastraCompositeStore } from '@mastra/core/storage';
import { PostgresStore } from '@mastra/pg';
import { Pool } from 'pg';

const MASTRA_POOL_OPTIONS = {
  allowExitOnIdle: true,
  idleTimeoutMillis: 30_000,
  max: 20,
} as const;

export function createMastraPostgresStore(connectionString: string): PostgresStore {
  const pool = new Pool({
    connectionString,
    ...MASTRA_POOL_OPTIONS,
  });
  return new PostgresStore({
    id: 'plus-one-memory-pg',
    pool,
    schemaName: 'mastra_memory',
    disableInit: true,
  });
}

function mastraDomains(store: PostgresStore) {
  const memory = store.stores.memory;
  const workflows = store.stores.workflows;

  if (memory === undefined) {
    throw new Error('Mastra Postgres memory domain is not available');
  }
  if (workflows === undefined) {
    throw new Error('Mastra Postgres workflows domain is not available');
  }

  return { memory, workflows };
}

class MastraMemoryStorage extends MastraCompositeStore {
  private closed = false;

  constructor(
    private readonly store: PostgresStore,
    private readonly pool: Pool,
  ) {
    super({
      id: 'plus-one-memory',
      domains: mastraDomains(store),
    });
  }

  override async init(): Promise<void> {
    return;
  }

  override async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.store.close();
    await this.pool.end();
  }
}

export function createMastraMemoryStorage(connectionString: string): MastraCompositeStore {
  const store = createMastraPostgresStore(connectionString);
  return new MastraMemoryStorage(store, store.pool);
}
