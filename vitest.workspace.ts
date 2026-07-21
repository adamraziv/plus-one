import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineWorkspace } from 'vitest/config';

const resolveConfig = {
  alias: {
    '@plus-one/accounting': resolve('packages/accounting/src/index.ts'),
    '@plus-one/contracts': resolve('packages/contracts/src/index.ts'),
    '@plus-one/database': resolve('packages/database/src/index.ts'),
    '@plus-one/ingestion': resolve('packages/ingestion/src/index.ts'),
    '@plus-one/mutations': resolve('packages/mutations/src/index.ts'),
    '@plus-one/planning': resolve('packages/planning/src/index.ts'),
    '@plus-one/query': resolve('packages/query/src/index.ts'),
    '@plus-one/reporting': resolve('packages/reporting/src/index.ts'),
    '@plus-one/runtime/telegram/pairing-service': resolve('packages/runtime/src/telegram/pairing-service.ts'),
    '@plus-one/runtime': resolve('packages/runtime/src/index.ts'),
  },
};

const preferTypeScriptSource = {
  name: 'prefer-typescript-source',
  enforce: 'pre' as const,
  resolveId(source: string, importer: string | undefined) {
    if (importer === undefined || !source.startsWith('.') || !source.endsWith('.js')) return null;
    const candidate = resolve(dirname(importer), `${source.slice(0, -3)}.ts`);
    return existsSync(candidate) ? candidate : null;
  },
};

const databaseProject = {
  resolve: resolveConfig,
  plugins: [preferTypeScriptSource],
  test: {
    name: 'database',
    include: ['test/database/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
};

export default defineWorkspace([
  {
    resolve: resolveConfig,
    plugins: [preferTypeScriptSource],
    test: {
      name: 'unit',
      include: ['apps/**/{src,test}/**/*.test.ts', 'packages/**/src/**/*.test.ts'],
      environment: 'node',
    },
  },
  databaseProject,
  {
    resolve: resolveConfig,
    plugins: [preferTypeScriptSource],
    test: {
      name: 'integration',
      include: ['test/integration/**/*.test.ts'],
      environment: 'node',
      hookTimeout: 60_000,
      testTimeout: 60_000,
    },
  },
  {
    resolve: resolveConfig,
    plugins: [preferTypeScriptSource],
    test: {
      name: 'acceptance',
      include: ['test/acceptance/**/*.test.ts'],
      environment: 'node',
      fileParallelism: false,
      hookTimeout: 60_000,
      testTimeout: 60_000,
    },
  },
]);
