import { Mastra } from '@mastra/core';
import { createMastraMemoryStorage } from '@plus-one/database';

export function createMastra(memoryConnectionString: string): Mastra {
  return new Mastra({
    storage: createMastraMemoryStorage(memoryConnectionString),
  });
}
