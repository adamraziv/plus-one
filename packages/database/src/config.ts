import { z } from 'zod';

const DatabaseEnvironmentSchema = z.object({
  DATABASE_ADMIN_URL: z.string().url().optional(),
  DATABASE_MIGRATOR_URL: z.string().url(),
  DATABASE_ACCOUNTING_URL: z.string().url(),
  DATABASE_PLANNING_URL: z.string().url(),
  DATABASE_OPERATIONS_URL: z.string().url(),
  DATABASE_QUERY_URL: z.string().url(),
  DATABASE_MEMORY_URL: z.string().url(),
  PLUS_ONE_ACCOUNTING_PASSWORD: z.string().min(12),
  PLUS_ONE_PLANNING_PASSWORD: z.string().min(12),
  PLUS_ONE_OPERATIONS_PASSWORD: z.string().min(12),
  PLUS_ONE_QUERY_PASSWORD: z.string().min(12),
  PLUS_ONE_MEMORY_PASSWORD: z.string().min(12),
});

export type DatabasePoolRole = 'accounting' | 'planning' | 'operations' | 'query' | 'memory';

export interface DatabaseConfig {
  adminUrl?: string;
  migratorUrl: string;
  poolUrls: Record<DatabasePoolRole, string>;
  rolePasswords: {
    accounting: string;
    planning: string;
    operations: string;
    query: string;
    memory: string;
  };
}

export function loadDatabaseConfig(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): DatabaseConfig {
  const parsed = DatabaseEnvironmentSchema.parse(environment);

  return {
    ...(parsed.DATABASE_ADMIN_URL === undefined ? {} : { adminUrl: parsed.DATABASE_ADMIN_URL }),
    migratorUrl: parsed.DATABASE_MIGRATOR_URL,
    poolUrls: {
      accounting: parsed.DATABASE_ACCOUNTING_URL,
      planning: parsed.DATABASE_PLANNING_URL,
      operations: parsed.DATABASE_OPERATIONS_URL,
      query: parsed.DATABASE_QUERY_URL,
      memory: parsed.DATABASE_MEMORY_URL,
    },
    rolePasswords: {
      accounting: parsed.PLUS_ONE_ACCOUNTING_PASSWORD,
      planning: parsed.PLUS_ONE_PLANNING_PASSWORD,
      operations: parsed.PLUS_ONE_OPERATIONS_PASSWORD,
      query: parsed.PLUS_ONE_QUERY_PASSWORD,
      memory: parsed.PLUS_ONE_MEMORY_PASSWORD,
    },
  };
}
