import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { HouseholdIdSchema, QueryResultSchemaV1 } from '@plus-one/contracts';
import { type EvidenceHandle, type QueryToolRegistry } from '@plus-one/query';
import { analystSandboxToolId } from '@plus-one/runtime';

const QueryToolInputSchema = z.object({
  householdId: HouseholdIdSchema,
}).strict();

type MastraTool = ReturnType<typeof createTool>;

export function createQueryTools(input: {
  registry: QueryToolRegistry;
  withEvidenceHandle: <T>(work: (handle: Pick<EvidenceHandle, 'runTool'>) => Promise<T>) => Promise<T>;
  analystSandboxTool: MastraTool;
}): Record<string, MastraTool> {
  const tools: Record<string, MastraTool> = {
    [analystSandboxToolId]: input.analystSandboxTool,
  };

  for (const definition of input.registry.list()) {
    const id = `query_${definition.toolName}`;
    if (definition.parameters.length !== 1 || definition.parameters[0] !== '$1') {
      throw new TypeError(`Query tool ${definition.toolName} must be household-scoped with one $1 parameter`);
    }
    tools[id] = createTool({
      id,
      description: definition.description,
      inputSchema: QueryToolInputSchema,
      outputSchema: QueryResultSchemaV1,
      execute: async (inputData) => {
        const parsed = QueryToolInputSchema.parse(inputData);
        return input.withEvidenceHandle((handle) =>
          handle.runTool(definition.toolName, [parsed.householdId]));
      },
    });
  }

  return tools;
}
