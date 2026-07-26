import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freeModelIds, modelCatalogUrl } from '../apps/engine/src/model-catalog.js';

export type FreeModelSweepResult = {
  modelId: string;
  ok: boolean;
  durationMs: number;
  failureCode?: string;
};

type RunModel = (modelId: string) => Promise<{ ok: boolean; failureCode?: string }>;

export function workingMemoryAcceptanceArgs(): string[] {
  return [
    'exec',
    'vitest',
    '--workspace',
    'vitest.workspace.ts',
    'run',
    '--project',
    'acceptance',
    'test/acceptance/working-memory-live.acceptance.test.ts',
    '--no-file-parallelism',
    '-t',
    'working-memory-model-compatibility:',
  ];
}

export async function runSerialFreeModelSweep(input: {
  modelIds: readonly string[];
  runModel?: RunModel;
}): Promise<FreeModelSweepResult[]> {
  if (input.modelIds.length === 0) throw new Error('No free models were returned by the endpoint catalog.');
  const runModel = input.runModel ?? runAcceptanceForModel;
  const results: FreeModelSweepResult[] = [];
  for (const modelId of input.modelIds) {
    const startedAt = Date.now();
    const result = await runModel(modelId);
    results.push({
      modelId,
      ok: result.ok,
      durationMs: Date.now() - startedAt,
      ...(result.failureCode === undefined ? {} : { failureCode: result.failureCode }),
    });
  }
  return results;
}

async function runAcceptanceForModel(modelId: string): Promise<{ ok: boolean; failureCode?: string }> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', workingMemoryAcceptanceArgs(), {
      cwd: process.cwd(),
      env: { ...process.env, ORCHESTRATOR_MODEL: modelId },
      stdio: 'inherit',
    });
    child.once('error', () => resolve({ ok: false, failureCode: 'spawn_error' }));
    child.once('exit', (code, signal) => {
      resolve(code === 0 ? { ok: true } : { ok: false, failureCode: signal === null ? `exit_${code ?? 'unknown'}` : `signal_${signal}` });
    });
  });
}

async function discoverFreeModels(): Promise<string[]> {
  const endpoint = process.env.LLM_ENDPOINT;
  const apiKey = process.env.LLM_API_KEY;
  if (endpoint === undefined || apiKey === undefined) throw new Error('LLM_ENDPOINT and LLM_API_KEY are required.');
  const response = await fetch(modelCatalogUrl(endpoint), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error(`Model catalog unavailable: ${response.status}.`);
  return freeModelIds(await response.json());
}

async function main(): Promise<void> {
  const modelIds = await discoverFreeModels();
  const results = await runSerialFreeModelSweep({ modelIds });
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.modelId} ${result.durationMs}ms${result.failureCode === undefined ? '' : ` ${result.failureCode}`}`);
  }
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    console.error('free_model_sweep_failed');
    process.exitCode = 1;
  });
}
