import { MastraCompositeStore } from '@mastra/core/storage';
import { PostgresStore } from '@mastra/pg';

export function createMastraPostgresStore(connectionString: string): PostgresStore {
  return new PostgresStore({
    id: 'plus-one-memory-pg',
    connectionString,
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
  constructor(private readonly store: PostgresStore) {
    super({
      id: 'plus-one-memory',
      domains: mastraDomains(store),
    });
  }

  override async init(): Promise<void> {
    return;
  }

  override async close(): Promise<void> {
    await this.store.close();
  }
}

export function createMastraMemoryStorage(connectionString: string): MastraCompositeStore {
  return new MastraMemoryStorage(createMastraPostgresStore(connectionString));
}
