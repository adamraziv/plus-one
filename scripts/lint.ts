import { spawnSync } from 'node:child_process';

const scopes = [
  ['eslint.config.mjs', 'vitest.workspace.ts'],
  ['scripts'],
  ['apps/engine'],
  ['packages/accounting'],
  ['packages/contracts'],
  ['packages/database'],
  ['packages/ingestion'],
  ['packages/mutations'],
  ['packages/planning'],
  ['packages/query'],
  ['packages/reporting'],
  ['packages/runtime'],
  ['test'],
] as const;

for (const scope of scopes) {
  const result = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'eslint', ...scope, '--max-warnings=0'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--max-old-space-size=1024',
      },
      stdio: 'inherit',
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
