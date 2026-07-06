import { bootstrap } from './bootstrap.js';

interface Output {
  write(text: string): void;
}

export interface RunGatewayRuntimeDependencies {
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  stdout?: Output;
  stderr?: Output;
  waitForShutdown?: () => Promise<void>;
}

export async function runGatewayRuntime(dependencies: RunGatewayRuntimeDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const runtime = await bootstrap({ environment: dependencies.environment ?? process.env });
  stdout.write('Plus One gateway started.\n');
  try {
    await (dependencies.waitForShutdown ?? waitForProcessSignal)();
    return 0;
  } finally {
    await runtime.close();
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
