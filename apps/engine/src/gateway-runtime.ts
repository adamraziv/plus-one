import type { Mastra } from '@mastra/core';
import { configureLogging, getLogger, type Logger, type LoggingHandle } from '@plus-one/runtime';
import { bootstrap } from './bootstrap.js';
import {
  startMastraHttpServer,
  type MastraHttpServerHandle,
} from './server/mastra-http-server.js';

interface Output {
  write(text: string): void;
}

export interface RunGatewayRuntimeDependencies {
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  stdout?: Output;
  stderr?: Output;
  waitForShutdown?: () => Promise<void>;
  bootstrap?: typeof bootstrap;
  configureLogging?: typeof configureLogging;
  logger?: Logger;
  startServer?: (input: {
    mastra: Mastra;
    host: string;
    port: number;
    isReady: () => boolean;
  }) => Promise<MastraHttpServerHandle>;
}

export async function runGatewayRuntime(dependencies: RunGatewayRuntimeDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const environment = dependencies.environment ?? process.env;
  const logging: LoggingHandle = (dependencies.configureLogging ?? configureLogging)({
    environment,
    mode: 'gateway',
    stderr,
  });
  const logger = dependencies.logger ?? getLogger('engine.gateway');
  let ready = false;
  let runtime: Awaited<ReturnType<typeof bootstrap>> | undefined;
  let server: MastraHttpServerHandle | undefined;
  let status: 'stopped' | 'failed' = 'stopped';
  let failure: unknown;

  try {
    runtime = await (dependencies.bootstrap ?? bootstrap)({ environment });
    logger.info('runtime.started', { fields: { mode: 'gateway' } });
    server = await (dependencies.startServer ?? startMastraHttpServer)({
      mastra: runtime.mastra,
      host: runtime.config.host,
      port: runtime.config.port,
      isReady: () => ready,
    });
    await runtime.startIntake();
    ready = true;
    stdout.write(`Plus One gateway listening on ${runtime.config.host}:${runtime.config.port}.\n`);
    await (dependencies.waitForShutdown ?? waitForProcessSignal)();
  } catch (error) {
    status = 'failed';
    failure = error;
  } finally {
    ready = false;
    try {
      await runtime?.stopIntake().catch(() => undefined);
      try {
        await server?.close();
      } finally {
        await runtime?.close();
      }
    } catch (error) {
      status = 'failed';
      failure ??= error;
    } finally {
      logger.info('runtime.stopped', {
        fields: { mode: 'gateway', status },
        ...(failure === undefined ? {} : { error: failure }),
      });
      logging.close();
    }
  }

  if (failure !== undefined) {
    throw failure;
  }
  return 0;
}

function waitForProcessSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      resolve();
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}
