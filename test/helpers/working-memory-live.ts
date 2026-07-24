import { Pool } from 'pg';
import {
  HouseholdWorkingMemorySchema,
  type HouseholdWorkingMemory,
  type HouseholdWorkingMemoryPatch,
} from '@plus-one/contracts';
import {
  createOrchestratorSessionMemory,
  type OrchestratorSessionMemoryPort,
} from '../../apps/engine/src/memory/orchestrator-session-memory.js';
import type { EngineLlmModelConfig } from '../../apps/engine/src/config.js';
import { createPostgresTestContext, type PostgresTestContext } from './postgres.js';
import {
  startProductionGatewayServer,
  type ProductionGatewayServerHandle,
} from './production-gateway-server.js';

const REQUIRED_LIVE_ENVIRONMENT = [
  'LLM_ENDPOINT',
  'LLM_API_KEY',
  'ORCHESTRATOR_MODEL',
  'LEAD_MODEL',
  'MAKER_MODEL',
  'CHECKER_MODEL',
  'RESEARCH_MODEL',
] as const;

export type WorkingMemoryLiveModelEnvironment = Record<
  (typeof REQUIRED_LIVE_ENVIRONMENT)[number],
  string
>;

export type MemoryPrivilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

export interface WorkingMemoryLiveHarness {
  context: PostgresTestContext;
  gateway: ProductionGatewayServerHandle;
  model: EngineLlmModelConfig;
  stop(): Promise<void>;
}

export function requireWorkingMemoryLiveEnvironment(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): WorkingMemoryLiveModelEnvironment {
  const required = ['DATABASE_ADMIN_URL', ...REQUIRED_LIVE_ENVIRONMENT] as const;
  for (const name of required) {
    if (typeof environment[name] !== 'string' || environment[name]!.length === 0) {
      throw new Error(`${name} is required for Working Memory live acceptance tests.`);
    }
  }

  return Object.fromEntries(REQUIRED_LIVE_ENVIRONMENT.map((name) => [name, environment[name]!])) as WorkingMemoryLiveModelEnvironment;
}

export async function startWorkingMemoryLiveHarness(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<WorkingMemoryLiveHarness> {
  const models = requireWorkingMemoryLiveEnvironment(environment);
  const context = await createPostgresTestContext('working_memory_live');
  try {
    const gateway = await startProductionGatewayServer({
      env: {
        ...databaseEnvironment(context),
        ...models,
        TELEGRAM_BOT_TOKEN: undefined,
        TELEGRAM_WEBHOOK_URL: undefined,
        TELEGRAM_WEBHOOK_SECRET: undefined,
        TELEGRAM_API_BASE_URL: undefined,
      },
      useConfiguredModel: true,
    });
    let stopped = false;
    return {
      context,
      gateway,
      model: {
        id: models.ORCHESTRATOR_MODEL,
        endpoint: models.LLM_ENDPOINT,
        apiKey: models.LLM_API_KEY,
      },
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await gateway.stop();
        await context.cleanup();
      },
    };
  } catch (error) {
    await context.cleanup();
    throw error;
  }
}

export async function readLiveWorkingMemory(input: {
  connectionString: string;
  model: EngineLlmModelConfig;
  threadId: string;
  resourceId: string;
}): Promise<HouseholdWorkingMemory> {
  const memory = createOrchestratorSessionMemory({
    connectionString: input.connectionString,
    model: input.model,
  });
  try {
    const result = await memory.readWorkingMemory({
      threadId: input.threadId,
      resourceId: input.resourceId,
    });
    if (result.status === 'failed') {
      throw new Error(`Working Memory readback failed with ${result.outcome.code}.`);
    }
    return HouseholdWorkingMemorySchema.parse(result.value);
  } finally {
    await memory.close();
  }
}

export async function writeLiveWorkingMemory(input: {
  connectionString: string;
  model: EngineLlmModelConfig;
  threadId: string;
  resourceId: string;
  patch: HouseholdWorkingMemoryPatch;
}): Promise<void> {
  const memory: OrchestratorSessionMemoryPort = createOrchestratorSessionMemory({
    connectionString: input.connectionString,
    model: input.model,
  });
  try {
    const outcome = await memory.applyWorkingMemoryPatch({
      threadId: input.threadId,
      resourceId: input.resourceId,
      patch: input.patch,
    });
    if (outcome.status !== 'succeeded') {
      throw new Error(`Working Memory seed failed with ${outcome.code}.`);
    }
  } finally {
    await memory.close();
  }
}

export async function withRevokedMemoryPrivileges<T>(
  context: PostgresTestContext,
  privileges: readonly MemoryPrivilege[],
  work: () => Promise<T>,
): Promise<T> {
  if (privileges.length === 0) throw new Error('At least one memory privilege is required.');
  const admin = new Pool({ connectionString: context.migratorUrl, max: 1 });
  const privilegeList = privileges.join(', ');
  try {
    await admin.query(
      `REVOKE ${privilegeList} ON TABLE mastra_memory.mastra_resources FROM plus_one_memory`,
    );
    return await work();
  } finally {
    try {
      await admin.query(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mastra_memory.mastra_resources TO plus_one_memory',
      );
    } finally {
      await admin.end();
    }
  }
}

function databaseEnvironment(context: PostgresTestContext): NodeJS.ProcessEnv {
  return {
    DATABASE_MIGRATOR_URL: context.migratorUrl,
    DATABASE_ACCOUNTING_URL: context.roleUrls.accounting,
    DATABASE_PLANNING_URL: context.roleUrls.planning,
    DATABASE_OPERATIONS_URL: context.roleUrls.operations,
    DATABASE_QUERY_URL: context.roleUrls.query,
    DATABASE_MEMORY_URL: context.roleUrls.memory,
  };
}
