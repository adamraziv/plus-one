import { loadDatabaseConfig, type DatabaseConfig } from '@plus-one/database';
import { z } from 'zod';

const EngineEnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ENGINE_HOST: z.string().min(1).default('127.0.0.1'),
  ENGINE_PORT: z.coerce.number().int().min(1).max(65_535).default(4111),
});

export interface EngineConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  database: DatabaseConfig;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): EngineConfig {
  const engine = EngineEnvironmentSchema.parse(environment);

  return {
    nodeEnv: engine.NODE_ENV,
    host: engine.ENGINE_HOST,
    port: engine.ENGINE_PORT,
    database: loadDatabaseConfig(environment),
  };
}
