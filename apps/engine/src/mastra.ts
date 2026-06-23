import { Mastra } from '@mastra/core';
import type { Agent } from '@mastra/core/agent';
import { createMastraMemoryStorage } from '@plus-one/database';

export function createMastra(memoryConnectionString: string, agents: Record<string, Agent> = {}): Mastra {
  return new Mastra({
    storage: createMastraMemoryStorage(memoryConnectionString),
    agents,
  });
}
