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
import { validateConfiguredModels } from './model-catalog.js';
import { createRuntimeRoutes } from './runtime-routes.js';
import { createTeamRuntime } from './team-runtime.js';

interface BootstrapDependencies {
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  createPools?: typeof createDatabasePools;
  verifyPools?: typeof verifyDatabasePools;
  closePools?: typeof closeDatabasePools;
  validateModels?: typeof validateConfiguredModels;
  createMastraInstance?: typeof createMastra;
  createAgentSystemInstance?: typeof createAgentSystem;
  queryTools?: RoleAgentTools;
  orchestratorAgent?: Agent;
}

export async function bootstrap(dependencies: BootstrapDependencies = {}) {
  const config = loadConfig(dependencies.environment ?? process.env);
  await (dependencies.validateModels ?? validateConfiguredModels)({
    endpoint: config.models.orchestrator.endpoint,
    apiKey: config.models.orchestrator.apiKey,
    modelIds: [
      config.models.orchestrator.id,
      config.models.lead.id,
      config.models.maker.id,
      config.models.checker.id,
      config.models.research.id,
    ],
  });
  const pools = (dependencies.createPools ?? createDatabasePools)(config.database.poolUrls);
  const queryTools = dependencies.queryTools ?? {};
  if (config.nodeEnv === 'production' && Object.keys(queryTools).length === 0) {
    throw new Error('Production bootstrap requires configured Query tools.');
  }
  if (config.nodeEnv === 'production' && dependencies.orchestratorAgent === undefined) {
    throw new Error('Production bootstrap requires a configured orchestrator agent.');
  }
  const agentSystem = (dependencies.createAgentSystemInstance ?? createAgentSystem)({
    models: config.models,
    queryTools,
    ...(dependencies.orchestratorAgent === undefined ? {} : { orchestratorAgent: dependencies.orchestratorAgent }),
  });
  const teamRuntime = createTeamRuntime({ pools, agentSystem });
  const apiRoutes = createRuntimeRoutes({ config, agentSystem, teamRuntime });
  const mastra = (dependencies.createMastraInstance ?? createMastra)(
    config.database.poolUrls.memory,
    agentSystem.mastraAgents,
    apiRoutes,
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
