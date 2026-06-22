import { z } from 'zod';
import { PlusOneError } from '@plus-one/contracts';
import type { ReadOnlySqlValidator } from './sql-validator.js';

export const QueryToolNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]+$/);

export const QueryToolDefinitionSchema = z
  .object({
    toolName: QueryToolNameSchema,
    relationNames: z.array(z.string().regex(/^reporting\.[a-z_]+$/)).min(1).max(8),
    sql: z.string().min(1).max(10_000),
    parameters: z.array(z.string().regex(/^\$[0-9]+$/)),
    limit: z.number().int().positive().max(500),
    description: z.string().min(1).max(1_000),
  })
  .strict();

export type QueryToolDefinition = z.infer<typeof QueryToolDefinitionSchema>;

export type QueryToolRow = Readonly<Record<string, unknown>>;

export interface QueryToolRegistryOptions {
  allowedRelations: readonly string[];
  maxRows: number;
  validator: ReadOnlySqlValidator;
}

export class QueryToolRegistry {
  private readonly tools = new Map<string, QueryToolDefinition>();

  constructor(private readonly options: QueryToolRegistryOptions) {}

  register(definition: QueryToolDefinition): void {
    const parsed = QueryToolDefinitionSchema.parse(definition);
    this.options.validator.validate({
      sql: parsed.sql,
      allowedRelations: this.options.allowedRelations,
      maxRows: this.options.maxRows,
    });
    if (parsed.limit > this.options.maxRows) {
      throw new PlusOneError({
        category: 'policy_rejected',
        code: 'query_tool_limit_exceeds_max',
        message: `Query tool ${parsed.toolName} exceeds maxRows`,
        retry: 'never',
        receiptLookupRequired: false,
        details: { toolName: parsed.toolName, limit: parsed.limit, maxRows: this.options.maxRows },
      });
    }
    this.tools.set(parsed.toolName, parsed);
  }

  get(toolName: string): QueryToolDefinition {
    const tool = this.tools.get(toolName);
    if (tool === undefined) {
      throw new PlusOneError({
        category: 'validation_rejected',
        code: 'query_tool_unknown',
        message: `Unknown query tool ${toolName}`,
        retry: 'never',
        receiptLookupRequired: false,
        details: { toolName },
      });
    }
    return tool;
  }

  list(): readonly QueryToolDefinition[] {
    return [...this.tools.values()].sort((a, b) => a.toolName.localeCompare(b.toolName));
  }
}
