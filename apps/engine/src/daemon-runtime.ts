import { closeSync, openSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearBackgroundRuntimeState,
  defaultBackgroundStatePath,
  loadBackgroundRuntimeState,
  saveBackgroundRuntimeState,
  type BackgroundRuntimeState,
} from './live-cli/background-state.js';

interface Output {
  write(text: string): void;
}

type DaemonChild = Pick<ChildProcess, 'pid' | 'unref'>;

export interface DaemonStateStore {
  load(): Promise<BackgroundRuntimeState | undefined>;
  save(state: BackgroundRuntimeState): Promise<void>;
  clear(): Promise<void>;
}

export interface DaemonRuntimeDependencies {
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  stdout?: Output;
  stderr?: Output;
  state?: DaemonStateStore;
  spawnProcess?: (input: {
    launcherPath: string;
    installationRoot: string;
    logFilePath: string;
  }) => Promise<DaemonChild> | DaemonChild;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  isProcessAlive?: (pid: number) => boolean;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  launcherPath?: string;
  logFilePath?: string;
  timeoutMs?: number;
}

export async function startGatewayDaemon(input: DaemonRuntimeDependencies = {}): Promise<number> {
  const environment = input.environment ?? process.env;
  const stdout = input.stdout ?? process.stdout;
  const isProcessAlive = input.isProcessAlive ?? defaultIsProcessAlive;
  const state = input.state ?? createStateStore(environment, isProcessAlive);
  const existing = await state.load();
  if (existing !== undefined) {
    stdout.write(`Plus One is already running (pid ${existing.enginePid}).\n`);
    return 0;
  }

  const address = gatewayAddress(environment);
  const installationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const launcherPath = input.launcherPath ?? resolve(installationRoot, 'bin/plus-one.mjs');
  const logFilePath = input.logFilePath ?? join(dirname(defaultBackgroundStatePath(environment)), 'gateway.log');
  stdout.write('Plus One gateway starting...\n');

  const child = await (input.spawnProcess ?? spawnForegroundGateway)({
    launcherPath,
    installationRoot,
    logFilePath,
  });
  if (child.pid === undefined) throw new Error('Plus One gateway process did not expose a PID.');

  const ready = await waitForGatewayReady({
    address,
    fetchFn: input.fetch ?? fetch,
    isProcessAlive,
    pid: child.pid,
    sleep: input.sleep ?? defaultSleep,
    timeoutMs: input.timeoutMs ?? 15_000,
  });
  if (!ready) {
    try {
      (input.killProcess ?? process.kill)(-child.pid, 'SIGTERM');
    } catch {
      return Promise.reject(new Error(`Plus One gateway did not become ready at ${address.url}.`));
    }
    throw new Error(`Plus One gateway did not become ready at ${address.url}.`);
  }

  await state.save({
    schemaVersion: 1,
    enginePid: child.pid,
    startedAt: (input.now ?? (() => new Date()))().toISOString(),
    command: ['plus-one', '--foreground'],
    cwd: installationRoot,
    logFilePath,
  });
  child.unref?.();
  stdout.write(`Plus One gateway listening on ${address.display}.\n`);
  return 0;
}

export async function stopGatewayDaemon(input: DaemonRuntimeDependencies = {}): Promise<number> {
  const environment = input.environment ?? process.env;
  const stdout = input.stdout ?? process.stdout;
  const isProcessAlive = input.isProcessAlive ?? defaultIsProcessAlive;
  const state = input.state ?? createStateStore(environment, isProcessAlive);
  const current = await state.load();
  if (current === undefined) {
    stdout.write('Plus One is stopped.\n');
    return 0;
  }

  const killProcess = input.killProcess ?? process.kill;
  try {
    try {
      killProcess(-current.enginePid, 'SIGTERM');
    } catch {
      // The process may have exited between state loading and signaling.
    }
    await waitForProcessExit({
      isProcessAlive,
      pid: current.enginePid,
      sleep: input.sleep ?? defaultSleep,
      timeoutMs: input.timeoutMs ?? 5_000,
    });
    if (isProcessAlive(current.enginePid)) killProcess(-current.enginePid, 'SIGKILL');
  } finally {
    await state.clear();
  }
  stdout.write('Plus One is stopped.\n');
  return 0;
}

export async function getGatewayDaemonStatus(input: DaemonRuntimeDependencies = {}): Promise<number> {
  const environment = input.environment ?? process.env;
  const stdout = input.stdout ?? process.stdout;
  const isProcessAlive = input.isProcessAlive ?? defaultIsProcessAlive;
  const state = input.state ?? createStateStore(environment, isProcessAlive);
  const current = await state.load();
  if (current === undefined) {
    stdout.write('Plus One is stopped.\n');
    return 0;
  }

  const address = gatewayAddress(environment);
  const ready = await probeGateway(address, input.fetch ?? fetch);
  stdout.write(ready
    ? `Plus One is listening on ${address.display}.\n`
    : 'Plus One is starting.\n');
  return 0;
}

function createStateStore(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
  isProcessAlive: (pid: number) => boolean,
): DaemonStateStore {
  const path = defaultBackgroundStatePath(environment);
  return {
    load: () => loadBackgroundRuntimeState({ path, isProcessAlive }),
    save: (state) => saveBackgroundRuntimeState({ path, state }),
    clear: () => clearBackgroundRuntimeState({ path }),
  };
}

async function spawnForegroundGateway(input: {
  launcherPath: string;
  installationRoot: string;
  logFilePath: string;
}): Promise<DaemonChild> {
  await mkdir(dirname(input.logFilePath), { recursive: true });
  const logFile = openSync(input.logFilePath, 'a');
  try {
    return spawn(process.execPath, [input.launcherPath, '--foreground'], {
      cwd: input.installationRoot,
      detached: true,
      stdio: ['ignore', logFile, logFile],
    });
  } finally {
    closeSync(logFile);
  }
}

function gatewayAddress(environment: Record<string, string | undefined>): {
  url: string;
  display: string;
} {
  const host = environment.ENGINE_HOST ?? '127.0.0.1';
  const port = Number(environment.ENGINE_PORT ?? '4111');
  const probeHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const formattedHost = probeHost.includes(':') && !probeHost.startsWith('[') ? `[${probeHost}]` : probeHost;
  return {
    url: `http://${formattedHost}:${port}/health/ready`,
    display: `${host}:${port}`,
  };
}

async function waitForGatewayReady(input: {
  address: { url: string };
  fetchFn: typeof fetch;
  isProcessAlive: (pid: number) => boolean;
  pid: number;
  sleep: (milliseconds: number) => Promise<void>;
  timeoutMs: number;
}): Promise<boolean> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (!input.isProcessAlive(input.pid)) return false;
    if (await probeGateway(input.address, input.fetchFn)) return true;
    await input.sleep(100);
  }
  return false;
}

async function probeGateway(address: { url: string }, fetchFn: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchFn(address.url);
    if (!response.ok) return false;
    const body = await response.json() as { status?: unknown };
    return body.status === 'ready';
  } catch {
    return false;
  }
}

async function waitForProcessExit(input: {
  isProcessAlive: (pid: number) => boolean;
  pid: number;
  sleep: (milliseconds: number) => Promise<void>;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  while (input.isProcessAlive(input.pid) && Date.now() < deadline) await input.sleep(100);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
