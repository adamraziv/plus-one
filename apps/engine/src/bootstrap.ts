import type { Agent } from '@mastra/core/agent';
import {
  closeDatabasePools,
  createDatabasePools,
  PostgresChannelPairingRepository,
  PostgresDeliveryRepository,
  verifyDatabasePools,
  type DatabasePools,
} from '@plus-one/database';
import {
  ChannelCommandHandler,
  defaultConversationIdGenerator,
  defaultDeliveryIdGenerator,
  FinalDeliveryHandler,
  OrchestratorIngress,
  TelegramPairingService,
  TelegramTransportAdapter,
} from '@plus-one/runtime';
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
import { createTelegramWebhookRoute } from './telegram/telegram-webhook.js';
import { createOrchestratorLoopWorkflow, runOrchestratorLoop } from './workflows/orchestrator-loop.js';

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
  const deliveryRepository = new PostgresDeliveryRepository(pools.operations);
  const channelCommands = new ChannelCommandHandler({
    repository: deliveryRepository,
    ids: defaultConversationIdGenerator,
  });
  const workflows = {
    'orchestrator-loop': createOrchestratorLoopWorkflow(orchestrator),
  };
  const runtimeRoutes = createRuntimeRoutes({
    config,
    agentSystem,
    teamRuntime,
    orchestrator,
    sessionMemory,
    commands: channelCommands,
    getMastra: () => mastra,
  });
  const apiRoutes = config.telegram === undefined
    ? runtimeRoutes
    : (() => {
        const telegramTransport = new TelegramTransportAdapter(config.telegram.botToken);
        const telegramDelivery = new FinalDeliveryHandler({
          repository: deliveryRepository,
          transports: {
            telegram: telegramTransport,
            slack: {
              send: async () => {
                throw new Error('Slack transport is not configured for Telegram webhook delivery.');
              },
            },
          },
          ids: defaultDeliveryIdGenerator,
        });

        return [
        ...runtimeRoutes,
        createTelegramWebhookRoute({
          webhookSecret: config.telegram.webhookSecret,
          pairing: new TelegramPairingService({
            repository: new PostgresChannelPairingRepository(pools.operations),
          }),
          deliveryRepository,
          inboundHandler: async (message) => {
            const ingress = new OrchestratorIngress({
              inbound: deliveryRepository,
              commands: channelCommands,
              orchestrator: {
                run: async (candidate) => {
                  const workflow = mastra.getWorkflow('orchestrator-loop');
                  return runOrchestratorLoop({ workflow, message: candidate.message });
                },
              },
              delivery: telegramDelivery,
            });
            return ingress.handleInbound(message);
          },
          telegram: {
            sendMessage: async ({ chatId, text }) => telegramTransport
              .send({ destination: { chatId }, body: text, format: 'plain_text' }),
          },
          ids: defaultConversationIdGenerator,
        }),
        ];
      })();
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
