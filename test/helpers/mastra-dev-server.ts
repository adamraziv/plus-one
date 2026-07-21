import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  startOpenAiCompatibleTestServer,
  type OpenAiCompatibleTestRequest,
  type OpenAiCompatibleTestResponder,
} from './openai-compatible-test-server.js';

export interface MastraDevServerHandle {
  baseUrl: string;
  output: () => string;
  modelRequests: () => readonly OpenAiCompatibleTestRequest[];
  stop: () => Promise<void>;
}

export async function startMastraDevServer(input: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  rejectOutput?: readonly RegExp[];
  modelResponder?: OpenAiCompatibleTestResponder;
} = {}): Promise<MastraDevServerHandle> {
  const cwd = input.cwd ?? process.cwd();
  const releaseLock = await acquireDevServerLock(cwd, input.timeoutMs ?? 90_000);
  const modelServer = await startOpenAiCompatibleTestServer({
    ...(input.modelResponder === undefined ? {} : { responder: input.modelResponder }),
  }).catch(async (error: unknown) => {
    await releaseLock();
    throw error;
  });
  const requestedPort = input.env?.PORT ?? String(await findFreePort());
  const runtimeEnvironment = {
    ...modelServer.environment,
    PORT: requestedPort,
    ...input.env,
  };
  const environmentFile = await createEnvironmentFile(cwd, runtimeEnvironment).catch(async (error: unknown) => {
    await modelServer.close();
    await releaseLock();
    throw error;
  });
  const child = spawn('pnpm', ['dev:mastra', '--env', environmentFile.path], {
    cwd,
    env: { ...process.env, ...runtimeEnvironment },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const append = (chunk: Buffer | string) => {
    output += chunk.toString();
  };

  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  const deadline = Date.now() + (input.timeoutMs ?? 90_000);

  while (!isReady(output)) {
    const cleanOutput = stripAnsi(output);
    if (input.rejectOutput?.some((pattern) => pattern.test(cleanOutput))) {
      await stopChild(child);
      await releaseLock();
      await modelServer.close();
      await environmentFile.close();
      throw new Error(`Mastra dev server emitted rejected output.\n${output}`);
    }
    if (child.exitCode !== null) {
      await releaseLock();
      await modelServer.close();
      await environmentFile.close();
      throw new Error(`Mastra dev server exited before ready.\n${output}`);
    }
    if (Date.now() >= deadline) {
      await stopChild(child);
      await releaseLock();
      await modelServer.close();
      await environmentFile.close();
      throw new Error(`Mastra dev server did not become ready.\n${output}`);
    }
    await sleep(250);
  }

  const port = output.match(/Studio:\s+http:\/\/localhost:(\d+)/i)?.[1];
  if (port === undefined) {
    await stopChild(child);
    await releaseLock();
    await modelServer.close();
    await environmentFile.close();
    throw new Error(`Mastra dev server did not report a Studio port.\n${output}`);
  }

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    output: () => output,
    modelRequests: modelServer.requests,
    stop: async () => {
      await stopChild(child);
      await releaseLock();
      await modelServer.close();
      await environmentFile.close();
    },
  };
}

async function createEnvironmentFile(cwd: string, environment: NodeJS.ProcessEnv): Promise<{
  path: string;
  close(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'plus-one-mastra-env-'));
  const path = join(directory, '.env');
  const content = Object.entries(environment)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n');
  const baseEnvironment = await readFile(join(cwd, '.env'), 'utf8').catch(() => '');
  await writeFile(path, `${baseEnvironment.trimEnd()}\n${content}\n`, { mode: 0o600 });
  return {
    path,
    close: async () => rm(directory, { recursive: true, force: true }),
  };
}

async function acquireDevServerLock(cwd: string, timeoutMs: number): Promise<() => Promise<void>> {
  const lockPath = resolve(cwd, '.mastra-dev-server-test.lock');
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(lockPath, { force: true, recursive: true });
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Mastra dev server test lock: ${lockPath}`);
      }
      const ownerPid = await readLockOwner(lockPath);
      if (ownerPid === undefined || !isProcessAlive(ownerPid)) {
        await rm(lockPath, { force: true, recursive: true });
        continue;
      }
      await sleep(250);
    }
  }
}

async function readLockOwner(lockPath: string): Promise<number | undefined> {
  const content = await readFile(lockPath, 'utf8').catch(() => undefined);
  if (content === undefined) return undefined;
  const pid = Number(content.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM';
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, 'SIGINT');
    } catch {
      child.kill('SIGINT');
    }
  } else {
    child.kill('SIGINT');
  }
  await Promise.race([
    once(child, 'exit'),
    sleep(5_000).then(() => {
      if (pid !== undefined) {
        try {
          process.kill(-pid, 'SIGKILL');
          return;
        } catch {
          child.kill('SIGKILL');
          return;
        }
      }
      child.kill('SIGKILL');
    }),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  if (address === null || typeof address === 'string') throw new Error('Free port lookup returned no address');
  return address.port;
}

function isReady(output: string): boolean {
  const cleanOutput = stripAnsi(output);
  return /mastra\s+1\.[0-9.]+\s+ready/i.test(cleanOutput) || /\bready in \d+ ms\b/i.test(cleanOutput);
}

function stripAnsi(output: string): string {
  return output.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g'), '');
}
