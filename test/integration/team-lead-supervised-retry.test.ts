import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  InboundChannelMessageSchemaV1,
} from '@plus-one/contracts';
import { closeDatabasePools, createDatabasePools } from '@plus-one/database';
import { budgetingTeamDefinition } from '@plus-one/planning';
import { createAgentSystem } from '../../apps/engine/src/agent-catalog.js';
import { loadConfig } from '../../apps/engine/src/config.js';
import { createDefaultQueryTools } from '../../apps/engine/src/query-tools.js';
import { createTeamRuntime } from '../../apps/engine/src/team-runtime.js';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';

let context: PostgresTestContext | undefined;
let owner: Pool | undefined;
let pools: ReturnType<typeof createDatabasePools> | undefined;

afterEach(async () => {
  if (pools !== undefined) await closeDatabasePools(pools);
  await owner?.end();
  await context?.cleanup();
  pools = undefined;
  owner = undefined;
  context = undefined;
});

describe('configured budgeting provider', () => {
  it('returns typed insufficient evidence without a mutation', async () => {
    context = await createPostgresTestContext('team_lead_supervised_retry');
    owner = new Pool({ connectionString: context.migratorUrl });
    await owner.query(
      `INSERT INTO operations.households
         (household_id, reporting_currency, reporting_timezone)
       VALUES ($1, 'USD', 'UTC')`,
      [householdId],
    );
    pools = createDatabasePools(context.roleUrls);

    const agentSystem = createAgentSystem({
      models: loadConfig().models,
      queryTools: createDefaultQueryTools(pools),
    });
    const runtime = createTeamRuntime({ pools, agentSystem });

    const result = await runtime.runTeamLead({
      message: message(),
      team: budgetingTeamDefinition,
      request: {
        schemaName: 'budgeting-lead-request',
        schemaVersion: 1,
        intent: 'budget_plan',
        request: {
          schemaName: 'budget-plan-request-draft',
          schemaVersion: 1,
          instruction: 'Help me create a budget.',
          scopeKey: 'monthly',
        },
      },
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: 'insufficient_evidence',
      effect: { state: 'none' },
    });
    expect(result.outstanding.length).toBeGreaterThan(0);
  });
});

function message() {
  return InboundChannelMessageSchemaV1.parse({
    schemaName: 'inbound-channel-message',
    schemaVersion: 1,
    conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    householdId,
    channel: 'telegram',
    externalMessageId: 'telegram:42:supervised-retry',
    receivedAt: '2026-07-29T08:47:01.224Z',
    speaker: { principalRef: 'telegram:user:42' },
    body: 'Help me create a budget.',
    attachments: [],
    metadata: { destination: { chatId: 'telegram-chat-42' } },
  });
}
