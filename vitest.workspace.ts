import { defineWorkspace, type TestProjectConfiguration } from 'vitest/config';

// Vitest 3.2 accepts this at runtime, but the workspace typing omits it.
const databaseProject = {
  fileParallelism: false,
  test: {
    name: 'database',
    include: ['test/database/**/*.test.ts'],
    environment: 'node',
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
} as unknown as TestProjectConfiguration;

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['apps/**/{src,test}/**/*.test.ts', 'packages/**/src/**/*.test.ts'],
      environment: 'node',
    },
  },
  databaseProject,
  {
    test: {
      name: 'integration',
      include: ['test/integration/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    test: {
      name: 'acceptance',
      include: ['test/acceptance/**/*.test.ts'],
      environment: 'node',
    },
  },
]);
