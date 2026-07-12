import { configureLogging, getLogger, type Logger, type LoggingHandle } from '@plus-one/runtime';
import { bootstrap } from './bootstrap.js';

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
  let runtime: Awaited<ReturnType<typeof bootstrap>> | undefined;
  let status: 'stopped' | 'failed' = 'stopped';
  let failure: unknown;
  try {
    runtime = await (dependencies.bootstrap ?? bootstrap)({ environment });
    logger.info('runtime.started', { fields: { mode: 'gateway' } });
    stdout.write('Plus One gateway started.\n');
    await (dependencies.waitForShutdown ?? waitForProcessSignal)();
    return 0;
  } catch (error) {
    status = 'failed';
    failure = error;
    throw error;
  } finally {
    try {
      await runtime?.close();
    } catch (error) {
      status = 'failed';
      failure ??= error;
      throw error;
    } finally {
      logger.info('runtime.stopped', {
        fields: { mode: 'gateway', status },
        ...(failure === undefined ? {} : { error: failure }),
      });
      logging.close();
    }
  }
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
