import type { Mastra } from '@mastra/core';
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
  startServer?: (input: {
    mastra: Mastra;
    host: string;
    port: number;
    isReady: () => boolean;
  }) => Promise<MastraHttpServerHandle>;
}

export async function runGatewayRuntime(dependencies: RunGatewayRuntimeDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  let ready = false;
  let runtime: Awaited<ReturnType<typeof bootstrap>> | undefined;
  let server: MastraHttpServerHandle | undefined;
  try {
    runtime = await (dependencies.bootstrap ?? bootstrap)({
      environment: dependencies.environment ?? process.env,
    });
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
    return 0;
  } finally {
    ready = false;
    await runtime?.stopIntake().catch(() => undefined);
    await server?.close();
    await runtime?.close();
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
