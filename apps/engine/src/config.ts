import 'dotenv/config';
import { loadDatabaseConfig, type DatabaseConfig } from '@plus-one/database';
import { z } from 'zod';

const ModelIdSchema = z.string()
  .regex(/^[a-z][a-z0-9-]*\/[A-Za-z0-9._:-]+$/, 'Model id must be provider/model');

const EngineEnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ENGINE_HOST: z.string().min(1).default('127.0.0.1'),
  ENGINE_PORT: z.coerce.number().int().min(1).max(65_535).default(4111),
  LLM_ENDPOINT: z.string().url().default('https://api.openai.com/v1'),
  LLM_API_KEY: z.string().min(1).optional(),
  ORCHESTRATOR_MODEL: ModelIdSchema.default('openai/gpt-5'),
  LEAD_MODEL: ModelIdSchema.default('openai/gpt-5'),
  MAKER_MODEL: ModelIdSchema.default('openai/gpt-5-mini'),
  CHECKER_MODEL: ModelIdSchema.default('openai/gpt-5'),
  RESEARCH_MODEL: ModelIdSchema.default('openai/gpt-5'),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1).optional(),
}).superRefine((environment, context) => {
  if (environment.NODE_ENV !== 'test' && environment.LLM_API_KEY === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['LLM_API_KEY'],
      message: 'LLM_API_KEY is required outside test',
    });
  }
  if (
    (environment.TELEGRAM_BOT_TOKEN === undefined)
    !== (environment.TELEGRAM_WEBHOOK_SECRET === undefined)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['TELEGRAM_BOT_TOKEN'],
      message: 'TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET must be configured together',
    });
  }
});

export interface EngineLlmModelConfig {
  id: string;
  endpoint: string;
  apiKey: string;
}

export interface EngineConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  database: DatabaseConfig;
  models: {
    orchestrator: EngineLlmModelConfig;
    lead: EngineLlmModelConfig;
    maker: EngineLlmModelConfig;
    checker: EngineLlmModelConfig;
    research: EngineLlmModelConfig;
  };
  telegram?: {
    botToken: string;
    webhookSecret: string;
  };
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
    models: {
      orchestrator: model(engine.ORCHESTRATOR_MODEL, engine),
      lead: model(engine.LEAD_MODEL, engine),
      maker: model(engine.MAKER_MODEL, engine),
      checker: model(engine.CHECKER_MODEL, engine),
      research: model(engine.RESEARCH_MODEL, engine),
    },
    ...(engine.TELEGRAM_BOT_TOKEN === undefined || engine.TELEGRAM_WEBHOOK_SECRET === undefined
      ? {}
      : {
          telegram: {
            botToken: engine.TELEGRAM_BOT_TOKEN,
            webhookSecret: engine.TELEGRAM_WEBHOOK_SECRET,
          },
        }),
  };
}

function model(id: string, environment: z.infer<typeof EngineEnvironmentSchema>): EngineLlmModelConfig {
  return {
    id,
    endpoint: environment.LLM_ENDPOINT,
    apiKey: environment.LLM_API_KEY ?? 'test-api-key',
  };
}
