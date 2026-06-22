import { describe, expect, it, vi } from 'vitest';
import { runAnalystSandbox } from './analyst-sandbox-tool.js';

describe('runAnalystSandbox', () => {
  it('creates a fresh hardened sandbox and destroys it after success', async () => {
    const executeCommand = vi.fn(async () => ({
      stdout: JSON.stringify({
        schemaName: 'analyst-calculation-artifact',
        schemaVersion: 1,
        pythonSource: 'result = {"average": 60}',
        inputPayload: { rows: [] },
        stdout: '',
        stderr: '',
        exitCode: 0,
        result: { average: 60 },
        calculations: ['average'],
        assumptions: [],
        interpretation: 'Average is 60.',
      }),
      stderr: '',
      exitCode: 0,
    }));
    const destroy = vi.fn(async () => undefined);
    const sandboxFactory = vi.fn(() => ({
      start: vi.fn(async () => undefined),
      executeCommand,
      destroy,
    }));

    const output = await runAnalystSandbox({
      pythonSource: 'result = {"average": 60}',
      inputPayload: { rows: [] },
      sandboxFactory,
      sandboxIdFactory: () => 'sandbox_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    });

    expect(output.result).toEqual({ average: 60 });
    expect(sandboxFactory).toHaveBeenCalledWith(expect.objectContaining({
      id: 'sandbox_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      image: 'python:3.12-slim',
      network: 'none',
      readonlyRootfs: true,
      capDrop: ['ALL'],
      securityOpt: ['no-new-privileges:true'],
      tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
    }));
    expect(executeCommand).toHaveBeenCalledWith(
      'python',
      expect.arrayContaining(['-c']),
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys the sandbox when command execution fails', async () => {
    const destroy = vi.fn(async () => undefined);
    await expect(runAnalystSandbox({
      pythonSource: 'raise SystemExit(2)',
      inputPayload: { rows: [] },
      sandboxFactory: () => ({
        start: async () => undefined,
        executeCommand: async () => {
          throw new Error('boom');
        },
        destroy,
      }),
      sandboxIdFactory: () => 'sandbox_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    })).rejects.toThrow(/boom/);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
