import { z } from 'zod';
import { createWorkflow } from '@mastra/core/workflows';

export const orchestratorLoopWorkflow = createWorkflow({
  id: 'orchestrator-loop',
  description: 'Durable outer loop for orchestrator conversations.',
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ message: z.string() }),
}).commit();
