import { Mastra } from '@mastra/core';
import { describe, expect, it, vi } from 'vitest';
import { bootstrap } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { createMastra } from '../src/mastra.js';

const environment = {
  NODE_ENV: 'test',
  ENGINE_HOST: '127.0.0.1',
  ENGINE_PORT: '4111',
  DATABASE_MIGRATOR_URL: 'postgresql://migrator:password@127.0.0.1:5432/plus_one',
  DATABASE_ACCOUNTING_URL: 'postgresql://accounting:password@127.0.0.1:5432/plus_one',
  DATABASE_PLANNING_URL: 'postgresql://planning:password@127.0.0.1:5432/plus_one',
  DATABASE_OPERATIONS_URL: 'postgresql://operations:password@127.0.0.1:5432/plus_one',
  DATABASE_QUERY_URL: 'postgresql://query:password@127.0.0.1:5432/plus_one',
  DATABASE_MEMORY_URL: 'postgresql://memory:password@127.0.0.1:5432/plus_one',
  PLUS_ONE_ACCOUNTING_PASSWORD: 'accounting-password',
  PLUS_ONE_PLANNING_PASSWORD: 'planning-password',
  PLUS_ONE_OPERATIONS_PASSWORD: 'operations-password',
  PLUS_ONE_QUERY_PASSWORD: 'query-password-123',
  PLUS_ONE_MEMORY_PASSWORD: 'memory-password-123',
};

describe('engine scaffold', () => {
  it('loads engine and database configuration together', () => {
    const config = loadConfig(environment);
    expect(config).toMatchObject({ nodeEnv: 'test', host: '127.0.0.1', port: 4111 });
    expect(config.database.poolUrls.operations).toContain('operations');
  });

  it('constructs Mastra with a configured memory storage URL', () => {
    const mastra = createMastra(environment.DATABASE_MEMORY_URL);
    const storage = mastra.getStorage();

    expect(mastra).toBeInstanceOf(Mastra);
    expect(storage?.stores?.memory).toBeDefined();
  });

  it('passes the memory URL to the Mastra factory and closes pools through the runtime handle', async () => {
    const pools = {} as never;
    const close = vi.fn(async () => undefined);
    const mastra = createMastra(environment.DATABASE_MEMORY_URL);
    const createMastraInstance = vi.fn((memoryConnectionString?: string) => {
      expect(memoryConnectionString).toBe(environment.DATABASE_MEMORY_URL);
      return mastra;
    });
    const runtime = await bootstrap({
      environment,
      createPools: () => pools,
      verifyPools: vi.fn(async () => undefined),
      closePools: close,
      createMastraInstance,
    });
    expect(createMastraInstance).toHaveBeenCalledTimes(1);
    await runtime.close();
    expect(close).toHaveBeenCalledWith(pools);
  });
});
