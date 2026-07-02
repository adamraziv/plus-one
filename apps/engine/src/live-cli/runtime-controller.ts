import { spawn, type ChildProcess } from 'node:child_process';
import {
  closeDatabasePools,
  createDatabasePools,
  verifyDatabasePools,
  type DatabasePools,
} from '@plus-one/database';
import { loadConfig } from '../config.js';
import type { BackgroundRuntimeState } from './background-state.js';
import type { RuntimeStatus } from './types.js';

type SpawnedProcess = Pick<ChildProcess, 'pid' | 'kill' | 'once' | 'on'> & {
  unref?: () => void;
};

export interface RuntimeStateStore {
  load(): Promise<BackgroundRuntimeState | undefined>;
  save(state: BackgroundRuntimeState): Promise<void>;
  clear(): Promise<void>;
}

export interface RuntimeControllerDependencies {
  cwd: string;
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  now?: () => Date;
  spawnProcess?: (command: string, args: string[], options: { cwd: string; detached?: boolean }) => SpawnedProcess;
  verifyDatabase?: () => Promise<void>;
  state: RuntimeStateStore;
  isProcessAlive: (pid: number) => boolean;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  stopTimeoutMs?: number;
}

export class LiveRuntimeController {
  private readonly dependencies: RuntimeControllerDependencies;
  private engine: SpawnedProcess | undefined;
  private status: RuntimeStatus = 'stopped';

  constructor(dependencies: RuntimeControllerDependencies) {
    this.dependencies = dependencies;
  }

  async detect(): Promise<RuntimeStatus> {
    const hidden = await this.dependencies.state.load();
    this.status = hidden === undefined ? 'stopped' : 'running-background';
    return this.status;
  }

  currentStatus(): RuntimeStatus {
    return this.status;
  }

  async start(): Promise<{ status: RuntimeStatus; message?: string }> {
    if (this.status !== 'stopped') return { status: this.status, message: 'Plus One is already running.' };

    this.status = 'starting';
    try {
      await this.runCommand('pnpm', ['db:up']);
      await (this.dependencies.verifyDatabase ?? (() => verifyDatabase(this.dependencies.environment)))();
      this.engine = this.spawn('pnpm', ['dev:mastra'], { detached: true });
      this.status = 'running-attached';
      return { status: this.status };
    } catch (error) {
      await this.runCommand('pnpm', ['db:down']).catch(() => undefined);
      this.status = 'stopped';
      return {
        status: this.status,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async stop(): Promise<{ status: RuntimeStatus; message?: string }> {
    this.status = 'stopping';
    if (this.engine !== undefined) {
      await stopProcess(this.engine, this.dependencies.killProcess);
      this.engine = undefined;
    } else {
      const hidden = await this.dependencies.state.load();
      if (hidden !== undefined) await this.stopHiddenProcess(hidden.enginePid);
    }
    await this.dependencies.state.clear();
    await this.runCommand('pnpm', ['db:down']);
    this.status = 'stopped';
    return { status: this.status };
  }

  async hideToBackground(): Promise<{ status: RuntimeStatus; message?: string }> {
    if (this.engine === undefined || this.engine.pid === undefined) {
      return { status: 'stopped', message: 'Nothing is running.' };
    }

    this.engine.unref?.();
    await this.dependencies.state.save({
      schemaVersion: 1,
      enginePid: this.engine.pid,
      startedAt: (this.dependencies.now ?? (() => new Date()))().toISOString(),
      command: ['pnpm', 'dev:mastra'],
      cwd: this.dependencies.cwd,
    });
    this.status = 'running-background';
    return { status: this.status };
  }

  private async runCommand(command: string, args: string[]): Promise<void> {
    const child = this.spawn(command, args, { detached: false });
    await waitForExit(child);
  }

  private spawn(command: string, args: string[], options: { detached: boolean }): SpawnedProcess {
    return (this.dependencies.spawnProcess ?? defaultSpawn)(command, args, {
      cwd: this.dependencies.cwd,
      detached: options.detached,
    });
  }

  private async stopHiddenProcess(pid: number): Promise<void> {
    const killProcess = this.dependencies.killProcess ?? ((targetPid, signal) => {
      process.kill(targetPid, signal);
    });
    killProcess(-pid, 'SIGTERM');

    const timeout = this.dependencies.stopTimeoutMs ?? 5_000;
    const sleep = this.dependencies.sleep ?? ((milliseconds) => new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    }));
    const deadline = Date.now() + timeout;
    while (this.dependencies.isProcessAlive(pid) && Date.now() < deadline) {
      await sleep(100);
    }
    if (this.dependencies.isProcessAlive(pid)) killProcess(-pid, 'SIGKILL');
  }
}

async function verifyDatabase(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<void> {
  const config = loadConfig(environment);
  const pools = createDatabasePools(config.database.poolUrls);
  try {
    await verifyDatabasePools(pools);
  } finally {
    await closeDatabasePools(pools as DatabasePools);
  }
}

function defaultSpawn(command: string, args: string[], options: { cwd: string; detached?: boolean }): SpawnedProcess {
  return spawn(command, args, {
    cwd: options.cwd,
    detached: options.detached ?? false,
    stdio: options.detached === true ? 'ignore' : 'inherit',
  });
}

async function stopProcess(
  child: SpawnedProcess,
  killProcess: ((pid: number, signal: NodeJS.Signals) => void) | undefined,
): Promise<void> {
  const stopped = waitForExit(child);
  stopProcessGroup(child, killProcess, 'SIGTERM');
  await stopped;
}

function stopProcessGroup(
  child: SpawnedProcess,
  killProcess: ((pid: number, signal: NodeJS.Signals) => void) | undefined,
  signal: NodeJS.Signals,
): void {
  if (child.pid !== undefined) {
    try {
      (killProcess ?? process.kill)(-child.pid, signal);
      return;
    } catch {
      child.kill(signal);
      return;
    }
  }
  child.kill(signal);
}

async function waitForExit(child: SpawnedProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`Command exited with code ${code}`));
    });
  });
}
