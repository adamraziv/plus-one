import type { Agent } from '@mastra/core/agent';
import {
  closeDatabasePools,
  createDatabasePools,
  PostgresDeliveryRepository,
  verifyDatabasePools,
  type DatabasePools,
} from '@plus-one/database';
import { ChannelCommandHandler, defaultConversationIdGenerator } from '@plus-one/runtime';
import { createAgentSystem } from './agent-catalog.js';
import { loadConfig } from './config.js';
import { createMastra } from './mastra.js';
import type { RoleAgentTools } from './mastra/role-agent.js';
import { validateConfiguredModels } from './model-catalog.js';
import { OrchestratorAgent } from './agents/orchestrator.js';
import { createOrchestratorSessionMemory } from './memory/orchestrator-session-memory.js';
import { createDefaultQueryTools } from './query-tools.js';
import { createRuntimeRoutes } from './runtime-routes.js';
import { createTeamRuntime } from './team-runtime.js';
import { createOrchestratorLoopWorkflow } from './workflows/orchestrator-loop.js';

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
  const queryTools = dependencies.queryTools ?? createDefaultQueryTools(pools);
  if (Object.keys(queryTools).length === 0) {
    throw new Error('Bootstrap requires configured Query tools.');
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
  const sessionMemory = createOrchestratorSessionMemory({
    connectionString: config.database.poolUrls.memory,
    model: config.models.orchestrator,
  });
  const orchestrator = new OrchestratorAgent({
    model: config.models.orchestrator,
    teams: agentSystem.teams,
    teamRuntime,
    sessionMemory,
  });
  const channelCommands = new ChannelCommandHandler({
    repository: new PostgresDeliveryRepository(pools.operations),
    ids: defaultConversationIdGenerator,
  });
  const workflows = {
    'orchestrator-loop': createOrchestratorLoopWorkflow(orchestrator),
  };
  const apiRoutes = createRuntimeRoutes({
    config,
    agentSystem,
    teamRuntime,
    orchestrator,
    sessionMemory,
    commands: channelCommands,
    getMastra: () => mastra,
  });
  const mastra = (dependencies.createMastraInstance ?? createMastra)(
    config.database.poolUrls.memory,
    agentSystem.mastraAgents,
    apiRoutes,
    workflows,
  );
  orchestrator.registerMastra(mastra);

  await (dependencies.verifyPools ?? verifyDatabasePools)(pools);

  return {
    config,
    mastra,
    pools,
    agentSystem,
    close: async (): Promise<void> => {
      await mastra.shutdown();
      await sessionMemory.close();
      await (dependencies.closePools ?? closeDatabasePools)(pools);
    },
  } satisfies {
    config: ReturnType<typeof loadConfig>;
    mastra: ReturnType<typeof createMastra>;
    pools: DatabasePools;
    agentSystem: ReturnType<typeof createAgentSystem>;
    close: () => Promise<void>;
  };
}
