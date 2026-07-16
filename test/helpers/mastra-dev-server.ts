import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rmdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startOpenAiCompatibleTestServer } from './openai-compatible-test-server.js';

export interface MastraDevServerHandle {
  baseUrl: string;
  output: () => string;
  stop: () => Promise<void>;
}

export async function startMastraDevServer(input: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  rejectOutput?: readonly RegExp[];
} = {}): Promise<MastraDevServerHandle> {
  const cwd = input.cwd ?? process.cwd();
  const releaseLock = await acquireDevServerLock(cwd, input.timeoutMs ?? 90_000);
  const modelServer = await startOpenAiCompatibleTestServer().catch(async (error: unknown) => {
    await releaseLock();
    throw error;
  });
  const environmentFile = await createEnvironmentFile(cwd, modelServer.environment).catch(async (error: unknown) => {
    await modelServer.close();
    await releaseLock();
    throw error;
  });
  const child = spawn('pnpm', ['dev:mastra', '--env', environmentFile.path], {
    cwd,
    env: { ...process.env, ...modelServer.environment, ...input.env },
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
      await mkdir(lockPath);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rmdir(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Mastra dev server test lock: ${lockPath}`);
      }
      await sleep(250);
    }
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

function isReady(output: string): boolean {
  const cleanOutput = stripAnsi(output);
  return /mastra\s+1\.[0-9.]+\s+ready/i.test(cleanOutput) || /\bready in \d+ ms\b/i.test(cleanOutput);
}

function stripAnsi(output: string): string {
  return output.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g'), '');
}
