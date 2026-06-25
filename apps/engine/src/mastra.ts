import { Mastra } from '@mastra/core';
import type { Agent } from '@mastra/core/agent';
import type { ApiRoute } from '@mastra/core/server';
import { createMastraMemoryStorage } from '@plus-one/database';

export function createMastra(
  memoryConnectionString: string,
  agents: Record<string, Agent> = {},
  apiRoutes: ApiRoute[] = [],
): Mastra {
  return new Mastra({
    storage: createMastraMemoryStorage(memoryConnectionString),
    agents,
    server: {
      apiRoutes,
    },
  });
}
