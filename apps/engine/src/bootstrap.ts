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
  ChannelGateway,
  ChannelCommandHandler,
  DelegatingChannelEventSink,
  defaultConversationIdGenerator,
  defaultDeliveryIdGenerator,
  FinalDeliveryHandler,
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
import { TelegramBotApiClient } from './telegram/telegram-bot-api.js';
import { TelegramChannelEventSink } from './telegram/telegram-channel-event-sink.js';
import { TelegramPollingReceiver } from './telegram/telegram-polling-receiver.js';
import { TelegramUpdateProcessor } from './telegram/telegram-update-processor.js';
import { createTelegramWebhookRoute } from './telegram/telegram-webhook.js';
import { createOrchestratorLoopWorkflow, runOrchestratorLoop } from './workflows/orchestrator-loop.js';

type TelegramBotApi = Pick<TelegramBotApiClient, 'deleteWebhook' | 'getUpdates' | 'setWebhook'>;
type TelegramPollingRuntime = {
  start(): Promise<void>;
  ready?: () => Promise<void>;
  abort(): void;
};

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
  createTelegramBotApiClient?: typeof createTelegramBotApiClient;
  createTelegramPollingReceiver?: typeof createTelegramPollingReceiver;
}

export interface BootstrappedRuntime {
  config: ReturnType<typeof loadConfig>;
  mastra: ReturnType<typeof createMastra>;
  pools: DatabasePools;
  agentSystem: ReturnType<typeof createAgentSystem>;
  startIntake(): Promise<void>;
  stopIntake(): Promise<void>;
  close(): Promise<void>;
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
  const channelEvents = new DelegatingChannelEventSink();
  const orchestrator = new OrchestratorAgent({
    model: config.models.orchestrator,
    teams: agentSystem.teams,
    teamRuntime,
    sessionMemory,
    channelEvents,
  });
  const deliveryRepository = new PostgresDeliveryRepository(pools.operations);
  const channelCommands = new ChannelCommandHandler({
    repository: deliveryRepository,
    ids: defaultConversationIdGenerator,
  });
  const workflows = {
    'orchestrator-loop': createOrchestratorLoopWorkflow(orchestrator),
  };
  let telegramApi: TelegramBotApi | undefined;
  let telegramGateway: ChannelGateway | undefined;
  let telegramProcessor: TelegramUpdateProcessor | undefined;
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
        telegramApi = (dependencies.createTelegramBotApiClient ?? createTelegramBotApiClient)(
          config.telegram.botToken,
          { ...(config.telegram.apiBaseUrl === undefined ? {} : { apiBaseUrl: config.telegram.apiBaseUrl }) },
        );
        const telegramTransport = new TelegramTransportAdapter(config.telegram.botToken, fetch, {
          ...(config.telegram.apiBaseUrl === undefined ? {} : { apiBaseUrl: config.telegram.apiBaseUrl }),
        });
        const telegramEvents = new TelegramChannelEventSink({ transport: telegramTransport });
        channelEvents.setSink(telegramEvents);
        const telegramDelivery = new FinalDeliveryHandler({
          repository: deliveryRepository,
          transports: {
            telegram: telegramTransport,
            slack: {
              send: async () => {
                throw new Error('Slack transport is not configured for Telegram gateway delivery.');
              },
            },
          },
          ids: defaultDeliveryIdGenerator,
        });
        telegramGateway = new ChannelGateway({
          inbound: deliveryRepository,
          commands: channelCommands,
          orchestrator: {
            run: async (candidate) => {
              const workflow = mastra.getWorkflow('orchestrator-loop');
              return runOrchestratorLoop({ workflow, message: candidate.message });
            },
          },
          delivery: telegramDelivery,
          sink: channelEvents,
        });
        const telegramGatewayForProcessor = telegramGateway;

        const processor = new TelegramUpdateProcessor({
          pairing: new TelegramPairingService({
            repository: new PostgresChannelPairingRepository(pools.operations),
          }),
          deliveryRepository,
          inboundHandler: async (message) => telegramGatewayForProcessor.handleInbound(message),
          telegram: {
            sendMessage: async ({ chatId, text }) => telegramTransport
              .send({ destination: { chatId }, body: text, format: 'plain_text' }),
          },
          ids: defaultConversationIdGenerator,
        });
        telegramProcessor = processor;

        const telegramRoutes = config.telegram.receiver.mode === 'webhook'
          ? [
              createTelegramWebhookRoute({
                webhookSecret: config.telegram.receiver.webhookSecret,
                processor,
              }),
            ]
          : [];

        return [...runtimeRoutes, ...telegramRoutes];
      })();
  const mastra = (dependencies.createMastraInstance ?? createMastra)(
    config.database.poolUrls.memory,
    agentSystem.mastraAgents,
    apiRoutes,
    workflows,
  );
  orchestrator.registerMastra(mastra);

  await (dependencies.verifyPools ?? verifyDatabasePools)(pools);

  let intakeStarted = false;
  let intakeStopped = false;
  let closed = false;
  let stopTelegramPolling: (() => void) | undefined;
  let telegramPollingTask: Promise<void> | undefined;

  const stopIntake = async (): Promise<void> => {
    if (!intakeStarted || intakeStopped) return;
    intakeStopped = true;
    stopTelegramPolling?.();
    await telegramPollingTask?.catch(() => undefined);
  };

  const startIntake = async (): Promise<void> => {
    if (intakeStarted) return;
    if (closed) throw new Error('Cannot start intake after runtime close.');
    intakeStarted = true;
    intakeStopped = false;

    if (config.telegram === undefined) return;
    if (telegramApi === undefined) throw new Error('Telegram API client was not initialized.');

    if (config.telegram.receiver.mode === 'webhook') {
      await telegramApi.setWebhook({
        url: config.telegram.receiver.webhookUrl,
        secretToken: config.telegram.receiver.webhookSecret,
        allowedUpdates: ['message'],
        dropPendingUpdates: false,
      });
      return;
    }

    if (telegramProcessor === undefined) throw new Error('Telegram update processor was not initialized.');
    const polling = (dependencies.createTelegramPollingReceiver ?? createTelegramPollingReceiver)({
      api: telegramApi,
      processor: telegramProcessor,
    });
    stopTelegramPolling = polling.abort;
    telegramPollingTask = polling.start();
    telegramPollingTask.catch((error: unknown) => {
      if (intakeStopped || closed) return;
      setImmediate(() => {
        if (intakeStopped || closed) return;
        throw error;
      });
    });
    try {
      await Promise.race([polling.ready?.() ?? Promise.resolve(), telegramPollingTask]);
    } catch (error) {
      await stopIntake();
      throw error;
    }
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await stopIntake();
    await telegramGateway?.shutdown();
    await mastra.shutdown();
    await sessionMemory.close();
    await (dependencies.closePools ?? closeDatabasePools)(pools);
  };

  return {
    config,
    mastra,
    pools,
    agentSystem,
    startIntake,
    stopIntake,
    close,
  } satisfies BootstrappedRuntime;
}

function createTelegramBotApiClient(
  botToken: string,
  options: { apiBaseUrl?: string },
): TelegramBotApi {
  return new TelegramBotApiClient(botToken, fetch, options);
}

function createTelegramPollingReceiver(input: {
  api: TelegramBotApi;
  processor: Pick<TelegramUpdateProcessor, 'handle'>;
}): TelegramPollingRuntime {
  const controller = new AbortController();
  let readySettled = false;
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: unknown) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const settleReady = (error?: unknown) => {
    if (readySettled) return;
    readySettled = true;
    if (error === undefined) {
      resolveReady?.();
      return;
    }
    rejectReady?.(error);
  };
  const receiver = new TelegramPollingReceiver({
    api: input.api,
    processor: input.processor,
    onReady: () => settleReady(),
  });
  return {
    start: async () => {
      try {
        await receiver.start(controller.signal);
        settleReady();
      } catch (error) {
        settleReady(error);
        throw error;
      }
    },
    ready: () => ready,
    abort: () => controller.abort(),
  };
}
