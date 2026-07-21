import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGatewayRuntime } from '../../apps/engine/src/gateway-runtime.js';
import { findFreePort } from './mastra-dev-server.js';
import {
  startOpenAiCompatibleTestServer,
  type OpenAiCompatibleTestRequest,
  type OpenAiCompatibleTestResponder,
} from './openai-compatible-test-server.js';

export interface ProductionGatewayServerHandle {
  baseUrl: string;
  modelRequests(): readonly OpenAiCompatibleTestRequest[];
  stop(): Promise<void>;
}

export async function startProductionGatewayServer(input: {
  env: NodeJS.ProcessEnv;
  modelResponder?: OpenAiCompatibleTestResponder;
  useConfiguredModel?: boolean;
  timeoutMs?: number;
}): Promise<ProductionGatewayServerHandle> {
  const modelServer = input.useConfiguredModel === true
    ? undefined
    : await startOpenAiCompatibleTestServer({
        ...(input.modelResponder === undefined ? {} : { responder: input.modelResponder }),
      });
  const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-gateway-live-'));
  const port = await findFreePort();
  let stopRuntime: () => void = () => undefined;
  const shutdown = new Promise<void>((resolve) => {
    stopRuntime = resolve;
  });
  const runtime = runGatewayRuntime({
    environment: {
      ...process.env,
      ...(modelServer?.environment ?? {}),
      ...input.env,
      NODE_ENV: 'test',
      ENGINE_HOST: '127.0.0.1',
      ENGINE_PORT: String(port),
      PLUS_ONE_HOME: homeDirectory,
    },
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
    waitForShutdown: () => shutdown,
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitUntilReady(baseUrl, runtime, input.timeoutMs ?? 30_000);
  } catch (error) {
    stopRuntime();
    await runtime.catch(() => undefined);
    await modelServer?.close();
    await rm(homeDirectory, { recursive: true, force: true });
    throw error;
  }
  let stopped = false;
  return {
    baseUrl,
    modelRequests: () => modelServer?.requests() ?? [],
    stop: async () => {
      if (stopped) return;
      stopped = true;
      stopRuntime();
      try {
        await runtime;
      } finally {
        await modelServer?.close();
        await rm(homeDirectory, { recursive: true, force: true });
      }
    },
  };
}

async function waitUntilReady(
  baseUrl: string,
  runtime: Promise<number>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let stopped: string | undefined;
  void runtime.then(
    (code) => { stopped = `exit ${code}`; },
    (error: unknown) => { stopped = String(error); },
  );
  while (Date.now() < deadline) {
    if (stopped !== undefined) throw new Error(`Production gateway stopped before readiness: ${stopped}`);
    const response = await fetch(`${baseUrl}/health/ready`).catch(() => undefined);
    if (response?.status === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Production gateway did not become ready within ${timeoutMs}ms.`);
}
