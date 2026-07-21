import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('installed plus-one command', () => {
  it('installs a symlink and runs from outside the repository', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'plus-one-installed-cli-'));
    const binDirectory = join(temporaryRoot, 'bin');
    const outsideDirectory = join(temporaryRoot, 'outside');
    await mkdir(outsideDirectory);

    try {
      const install = await runProcess('bash', [join(repositoryRoot, 'scripts/install-cli.sh')], {
        cwd: repositoryRoot,
        env: { ...process.env, PLUS_ONE_BIN_DIR: binDirectory },
      });
      expect(install.code).toBe(0);

      const link = join(binDirectory, 'plus-one');
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await realpath(link)).toBe(join(repositoryRoot, 'bin/plus-one.mjs'));

      const invocation = await runProcess(link, ['chat', 'hello'], {
        cwd: outsideDirectory,
        env: { ...process.env, NODE_ENV: 'test' },
      });
      expect(invocation.code).toBe(1);
      expect(invocation.stderr).toContain('Usage: plus-one');
      expect(invocation.stdout).toBe('');

      const status = await runProcess(link, ['status'], {
        cwd: outsideDirectory,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PLUS_ONE_LIVE_CLI_STATE_FILE: join(temporaryRoot, 'state', 'live-cli.json'),
        },
      });
      expect(status.code).toBe(0);
      expect(status.stdout).toContain('Plus One is stopped.');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('refuses to replace a regular file', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'plus-one-installed-cli-'));
    const binDirectory = join(temporaryRoot, 'bin');
    const link = join(binDirectory, 'plus-one');
    await mkdir(binDirectory);
    await writeFile(link, 'operator file\n');

    try {
      const install = await runProcess('bash', [join(repositoryRoot, 'scripts/install-cli.sh')], {
        cwd: repositoryRoot,
        env: { ...process.env, PLUS_ONE_BIN_DIR: binDirectory },
      });
      expect(install.code).not.toBe(0);
      expect(install.stderr).toContain('Refusing to replace non-symlink');
      await expect(readFile(link, 'utf8')).resolves.toBe('operator file\n');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

async function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolveProcess({ code, stdout, stderr }));
  });
}
