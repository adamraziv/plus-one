#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const launcherPath = realpathSync(fileURLToPath(import.meta.url));
const installationRoot = resolve(dirname(launcherPath), '..');
const tsxLoader = createRequire(import.meta.url).resolve('tsx');
const child = spawn(process.execPath, [
  '--import',
  tsxLoader,
  resolve(installationRoot, 'apps/engine/src/cli.ts'),
  ...process.argv.slice(2),
], {
  cwd: installationRoot,
  stdio: 'inherit',
});

let finished = false;

const forwardSignal = (signal) => {
  if (!finished) child.kill(signal);
};

process.once('SIGINT', () => forwardSignal('SIGINT'));
process.once('SIGTERM', () => forwardSignal('SIGTERM'));

child.once('error', (error) => {
  finished = true;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  finished = true;
  if (signal !== null) {
    process.exitCode = 128 + signalNumber(signal);
    return;
  }
  process.exitCode = code ?? 1;
});

function signalNumber(signal) {
  return {
    SIGINT: 2,
    SIGTERM: 15,
  }[signal] ?? 1;
}
