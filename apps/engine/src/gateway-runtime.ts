import type { Mastra } from '@mastra/core';
import {
  configureLogging,
  createOperationalLogError,
  getLogger,
  type Logger,
  type LoggingHandle,
} from '@plus-one/runtime';
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
    stdout,
    stderr,
  });
  const logger = dependencies.logger ?? getLogger('engine.gateway');
  let ready = false;
  let runtime: Awaited<ReturnType<typeof bootstrap>> | undefined;
  let server: MastraHttpServerHandle | undefined;
  let failure: unknown;
  let failureCategory: 'startup_failed' | 'runtime_failed' | 'shutdown_failed' | undefined;
  let phase: 'startup' | 'runtime' = 'startup';

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
    logger.info('runtime.readiness.changed', {
      fields: { mode: 'gateway', readiness: 'ready' },
    });
    stdout.write(`Plus One gateway listening on ${runtime.config.host}:${runtime.config.port}.\n`);
    phase = 'runtime';
    await (dependencies.waitForShutdown ?? waitForProcessSignal)();
  } catch (error) {
    failure = error;
    failureCategory = phase === 'startup' ? 'startup_failed' : 'runtime_failed';
  } finally {
    ready = false;
    logger.info('runtime.readiness.changed', {
      fields: { mode: 'gateway', readiness: 'not_ready' },
    });
    try {
      await runtime?.stopIntake().catch(() => undefined);
      try {
        await server?.close();
      } finally {
        await runtime?.close();
      }
    } catch (error) {
      if (failure === undefined) {
        failure = error;
        failureCategory = 'shutdown_failed';
      }
    } finally {
      if (failure === undefined) {
        logger.info('runtime.stopped', {
          fields: { mode: 'gateway', status: 'stopped' },
        });
      } else {
        logger.error('runtime.failed', {
          fields: {
            mode: 'gateway',
            failureCategory: failureCategory ?? 'runtime_failed',
          },
          error: createOperationalLogError({
            message: 'Plus One gateway runtime failed.',
            code: 'gateway_runtime_failed',
            category: failureCategory ?? 'runtime_failed',
          }),
        });
      }
      await logging.close().catch(() => undefined);
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
