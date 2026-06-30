import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

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
  const child = spawn('pnpm', ['dev:mastra'], {
    cwd: input.cwd ?? process.cwd(),
    env: { ...process.env, ...input.env },
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

  while (!/mastra\s+1\.[0-9.]+\s+ready/i.test(output)) {
    if (input.rejectOutput?.some((pattern) => pattern.test(output))) {
      await stopChild(child);
      throw new Error(`Mastra dev server emitted rejected output.\n${output}`);
    }
    if (child.exitCode !== null) {
      throw new Error(`Mastra dev server exited before ready.\n${output}`);
    }
    if (Date.now() >= deadline) {
      await stopChild(child);
      throw new Error(`Mastra dev server did not become ready.\n${output}`);
    }
    await sleep(250);
  }

  const port = output.match(/Studio:\s+http:\/\/localhost:(\d+)/i)?.[1];
  if (port === undefined) {
    await stopChild(child);
    throw new Error(`Mastra dev server did not report a Studio port.\n${output}`);
  }

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    output: () => output,
    stop: async () => {
      await stopChild(child);
    },
  };
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
        } catch {}
      }
      child.kill('SIGKILL');
    }),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
