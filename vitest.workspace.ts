import { resolve } from 'node:path';
import { defineWorkspace } from 'vitest/config';

const resolveConfig = {
  alias: {
    '@plus-one/accounting': resolve('packages/accounting/src/index.ts'),
    '@plus-one/contracts': resolve('packages/contracts/src/index.ts'),
    '@plus-one/database': resolve('packages/database/src/index.ts'),
    '@plus-one/mutations': resolve('packages/mutations/src/index.ts'),
    '@plus-one/runtime': resolve('packages/runtime/src/index.ts'),
  },
};

const databaseProject = {
  resolve: resolveConfig,
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
    test: {
      name: 'unit',
      include: ['apps/**/{src,test}/**/*.test.ts', 'packages/**/src/**/*.test.ts'],
      environment: 'node',
    },
  },
  databaseProject,
  {
    resolve: resolveConfig,
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
    test: {
      name: 'acceptance',
      include: ['test/acceptance/**/*.test.ts'],
      environment: 'node',
    },
  },
]);
