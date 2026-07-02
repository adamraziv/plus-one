import {
  closeDatabasePools,
  createDatabasePools,
  PostgresChannelPairingRepository,
} from '@plus-one/database';
import { TelegramPairingService } from '@plus-one/runtime';
import { loadConfig } from '../config.js';
import {
  clearBackgroundRuntimeState,
  defaultBackgroundStatePath,
  loadBackgroundRuntimeState,
  saveBackgroundRuntimeState,
} from './background-state.js';
import { LiveRuntimeController } from './runtime-controller.js';
import { runLiveCliSession } from './session.js';
import { LiveCliTelegramActions } from './telegram-actions.js';

interface Output {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(text: string): void;
}

export interface RunLiveCliDependencies {
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  stdin?: NodeJS.ReadStream & { setRawMode?: (value: boolean) => void };
  stdout?: Output;
  stderr?: Output;
}

export async function runLiveCli(dependencies: RunLiveCliDependencies = {}): Promise<number> {
  const environment = dependencies.environment ?? process.env;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const statePath = defaultBackgroundStatePath(environment);
  const runtime = new LiveRuntimeController({
    cwd: process.cwd(),
    environment,
    state: {
      load: async () => loadBackgroundRuntimeState({
        path: statePath,
        isProcessAlive,
      }),
      save: async (state) => saveBackgroundRuntimeState({ path: statePath, state }),
      clear: async () => clearBackgroundRuntimeState({ path: statePath }),
    },
    isProcessAlive,
  });

  const config = loadConfig(environment);
  const pools = createDatabasePools(config.database.poolUrls);
  try {
    const telegram = new LiveCliTelegramActions({
      environment,
      approvedBy: `cli:${environment.USER ?? 'operator'}`,
      service: new TelegramPairingService({
        repository: new PostgresChannelPairingRepository(pools.operations),
      }),
    });

    return runLiveCliSession({
      stdin: dependencies.stdin ?? process.stdin,
      stdout,
      stderr,
      environment,
      runtime,
      telegram,
    });
  } finally {
    await closeDatabasePools(pools);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
