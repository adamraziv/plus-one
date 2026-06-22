import { MastraCompositeStore } from '@mastra/core/storage';
import { PostgresStore } from '@mastra/pg';

function memoryDomains(store: PostgresStore) {
  const memory = store.stores.memory;

  if (memory === undefined) {
    throw new Error('Mastra Postgres memory domain is not available');
  }

  return { memory };
}

class MastraMemoryStorage extends MastraCompositeStore {
  constructor(private readonly store: PostgresStore) {
    super({
      id: 'plus-one-memory',
      domains: memoryDomains(store),
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
  return new MastraMemoryStorage(
    new PostgresStore({
      id: 'plus-one-memory-pg',
      connectionString,
      schemaName: 'mastra_memory',
      disableInit: true,
    }),
  );
}
