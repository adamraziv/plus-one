import type { Agent } from '@mastra/core/agent';
import {
  closeDatabasePools,
  createDatabasePools,
  verifyDatabasePools,
  type DatabasePools,
} from '@plus-one/database';
import { createAgentSystem } from './agent-catalog.js';
import { loadConfig } from './config.js';
import { createMastra } from './mastra.js';
import type { RoleAgentTools } from './mastra/role-agent.js';

interface BootstrapDependencies {
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  createPools?: typeof createDatabasePools;
  verifyPools?: typeof verifyDatabasePools;
  closePools?: typeof closeDatabasePools;
  createMastraInstance?: typeof createMastra;
  createAgentSystemInstance?: typeof createAgentSystem;
  queryTools?: RoleAgentTools;
  orchestratorAgent?: Agent;
}

export async function bootstrap(dependencies: BootstrapDependencies = {}) {
  const config = loadConfig(dependencies.environment ?? process.env);
  const pools = (dependencies.createPools ?? createDatabasePools)(config.database.poolUrls);
  const agentSystem = (dependencies.createAgentSystemInstance ?? createAgentSystem)({
    models: config.models,
    queryTools: dependencies.queryTools ?? {},
    ...(dependencies.orchestratorAgent === undefined ? {} : { orchestratorAgent: dependencies.orchestratorAgent }),
  });
  const mastra = (dependencies.createMastraInstance ?? createMastra)(
    config.database.poolUrls.memory,
    agentSystem.mastraAgents,
  );

  await (dependencies.verifyPools ?? verifyDatabasePools)(pools);

  return {
    config,
    mastra,
    pools,
    agentSystem,
    close: async (): Promise<void> => (dependencies.closePools ?? closeDatabasePools)(pools),
  } satisfies {
    config: ReturnType<typeof loadConfig>;
    mastra: ReturnType<typeof createMastra>;
    pools: DatabasePools;
    agentSystem: ReturnType<typeof createAgentSystem>;
    close: () => Promise<void>;
  };
}
