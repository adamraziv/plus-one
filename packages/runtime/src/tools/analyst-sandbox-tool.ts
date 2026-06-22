import { createTool } from '@mastra/core/tools';
import { DockerSandbox } from '@mastra/docker';
import {
  AnalystCalculationArtifactSchemaV1,
  PlusOneError,
} from '@plus-one/contracts';
import { ulid } from 'ulid';
import { z } from 'zod';

export const analystSandboxToolId = 'query.analyst_sandbox';

const AnalystSandboxInputSchema = z.object({
  pythonSource: z.string().min(1).max(20_000),
  inputPayload: z.record(z.string(), z.unknown()),
}).strict();

const maxInputPayloadBytes = 64 * 1024;
const maxCommandOutputBytes = 128 * 1024;

const runnerSource = `
import base64
import contextlib
import io
import json
import sys
import traceback

payload = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
source = base64.b64decode(sys.argv[2]).decode("utf-8")
namespace = {"input_payload": payload}
stdout_buffer = io.StringIO()
stderr_buffer = io.StringIO()
exit_code = 0
with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(stderr_buffer):
  try:
    exec(source, namespace, namespace)
  except Exception:
    exit_code = 1
    traceback.print_exc()
artifact = {
  "schemaName": "analyst-calculation-artifact",
  "schemaVersion": 1,
  "pythonSource": source,
  "inputPayload": payload,
  "stdout": stdout_buffer.getvalue(),
  "stderr": stderr_buffer.getvalue(),
  "exitCode": exit_code,
  "result": namespace.get("result"),
  "calculations": namespace.get("calculations", []),
  "assumptions": namespace.get("assumptions", []),
  "interpretation": namespace.get("interpretation", ""),
}
print(json.dumps(artifact))
sys.exit(exit_code)
`.trim();

type AnalystSandboxInput = z.infer<typeof AnalystSandboxInputSchema>;
type AnalystSandboxOutput = z.infer<typeof AnalystCalculationArtifactSchemaV1>;

type SandboxLike = {
  start(): Promise<void>;
  executeCommand?(
    command: string,
    args?: string[],
    options?: { timeout?: number; cwd?: string; env?: Record<string, string> },
  ): Promise<{ stdout: string; stderr?: string; exitCode?: number }>;
  destroy(): Promise<void>;
};

type SandboxFactory = (options: ConstructorParameters<typeof DockerSandbox>[0]) => SandboxLike;

export async function runAnalystSandbox(
  input: AnalystSandboxInput & {
    sandboxFactory?: SandboxFactory;
    sandboxIdFactory?: () => string;
  },
): Promise<AnalystSandboxOutput> {
  const parsed = AnalystSandboxInputSchema.parse({
    pythonSource: input.pythonSource,
    inputPayload: input.inputPayload,
  });
  const serializedPayload = JSON.stringify(parsed.inputPayload);
  const payloadBytes = Buffer.byteLength(serializedPayload, 'utf8');
  if (payloadBytes > maxInputPayloadBytes) {
    throw new PlusOneError({
      category: 'validation_rejected',
      code: 'analyst_input_payload_too_large',
      message: 'Analyst input payload exceeds the configured byte limit',
      retry: 'never',
      receiptLookupRequired: false,
      details: { payloadBytes, maxInputPayloadBytes },
    });
  }
  const sandboxId = input.sandboxIdFactory?.() ?? `sandbox_${ulid()}`;
  const factory = input.sandboxFactory ?? ((options) => new DockerSandbox(options));
  let sandbox: SandboxLike | undefined;

  try {
    sandbox = factory({
      id: sandboxId,
      image: 'python:3.12-slim',
      command: ['sleep', 'infinity'],
      env: {},
      network: 'none',
      memory: 128 * 1024 * 1024,
      memorySwap: 128 * 1024 * 1024,
      cpuPeriod: 100_000,
      cpuQuota: 100_000,
      pidsLimit: 64,
      readonlyRootfs: true,
      capDrop: ['ALL'],
      securityOpt: ['no-new-privileges:true'],
      tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
      timeout: 30_000,
    });
    await sandbox.start();
    if (sandbox.executeCommand === undefined) {
      throw new PlusOneError({
        category: 'unsupported_capability',
        code: 'analyst_sandbox_execute_command_missing',
        message: 'Configured analyst sandbox does not support command execution',
        retry: 'never',
        receiptLookupRequired: false,
        details: { sandboxId },
      });
    }
    const payload = Buffer.from(serializedPayload, 'utf8').toString('base64');
    const source = Buffer.from(parsed.pythonSource, 'utf8').toString('base64');
    const result = await sandbox.executeCommand('python', ['-c', runnerSource, payload, source], {
      timeout: 30_000,
      cwd: '/workspace',
      env: {},
    });
    const outputBytes = Buffer.byteLength(result.stdout, 'utf8');
    if (outputBytes > maxCommandOutputBytes) {
      throw new PlusOneError({
        category: 'policy_rejected',
        code: 'analyst_output_too_large',
        message: 'Analyst sandbox output exceeds the configured byte limit',
        retry: 'never',
        receiptLookupRequired: false,
        details: { outputBytes, maxCommandOutputBytes },
      });
    }
    const artifact = AnalystCalculationArtifactSchemaV1.parse(JSON.parse(result.stdout));
    if (artifact.exitCode !== 0) {
      throw new PlusOneError({
        category: 'runtime_failure',
        code: 'analyst_python_execution_failed',
        message: artifact.stderr || 'Analyst Python execution failed',
        retry: 'safe',
        receiptLookupRequired: false,
        details: { sandboxId, exitCode: artifact.exitCode },
      });
    }
    return artifact;
  } catch (error) {
    if (error instanceof PlusOneError) throw error;
    throw new PlusOneError({
      category: 'runtime_failure',
      code: 'analyst_sandbox_execution_failed',
      message: error instanceof Error ? error.message : 'Analyst sandbox execution failed',
      retry: 'safe',
      receiptLookupRequired: false,
      details: { sandboxId },
      cause: error,
    });
  } finally {
    await sandbox?.destroy().catch(() => undefined);
  }
}

export const createAnalystSandboxTool = () => createTool({
  id: analystSandboxToolId,
  description: 'Run checked Python analysis over checked query data in a fresh isolated sandbox.',
  inputSchema: AnalystSandboxInputSchema,
  outputSchema: AnalystCalculationArtifactSchemaV1,
  execute: async (inputData) => runAnalystSandbox(inputData),
});
