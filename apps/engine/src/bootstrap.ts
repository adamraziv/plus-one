import {
  closeDatabasePools,
  createDatabasePools,
  verifyDatabasePools,
  type DatabasePools,
} from '@plus-one/database';
import { loadConfig } from './config.js';
import { createMastra } from './mastra.js';

interface BootstrapDependencies {
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  createPools?: typeof createDatabasePools;
  verifyPools?: typeof verifyDatabasePools;
  closePools?: typeof closeDatabasePools;
  createMastraInstance?: typeof createMastra;
}

export async function bootstrap(dependencies: BootstrapDependencies = {}) {
  const config = loadConfig(dependencies.environment ?? process.env);
  const pools = (dependencies.createPools ?? createDatabasePools)(config.database.poolUrls);
  const mastra = (dependencies.createMastraInstance ?? createMastra)();

  await (dependencies.verifyPools ?? verifyDatabasePools)(pools);

  return {
    config,
    mastra,
    pools,
    close: async (): Promise<void> => (dependencies.closePools ?? closeDatabasePools)(pools),
  } satisfies {
    config: ReturnType<typeof loadConfig>;
    mastra: ReturnType<typeof createMastra>;
    pools: DatabasePools;
    close: () => Promise<void>;
  };
}
