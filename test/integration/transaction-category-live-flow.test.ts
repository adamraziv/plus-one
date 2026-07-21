import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import {
  accountingTeamDefinition,
} from '@plus-one/accounting';
import {
  InboundChannelMessageSchemaV1,
  TeamResultEnvelopeSchemaV2,
  type JsonValue,
} from '@plus-one/contracts';
import { closeDatabasePools, createDatabasePools } from '@plus-one/database';
import { createAgentSystem } from '../../apps/engine/src/agent-catalog.js';
import { OrchestratorAgent } from '../../apps/engine/src/agents/orchestrator.js';
import { createMastra } from '../../apps/engine/src/mastra.js';
import { createOrchestratorLoopWorkflow, runOrchestratorLoop } from '../../apps/engine/src/workflows/orchestrator-loop.js';
import { createTeamRuntime } from '../../apps/engine/src/team-runtime.js';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';

const ids = {
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  paymentAccountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  categoryAccountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
} as const;

let context: PostgresTestContext | undefined;
let owner: Pool | undefined;
let pools: ReturnType<typeof createDatabasePools> | undefined;
let mastra: ReturnType<typeof createMastra> | undefined;

afterEach(async () => {
  await mastra?.getStorage()?.close?.();
  if (pools !== undefined) await closeDatabasePools(pools);
  await owner?.end();
  await context?.cleanup();
  mastra = undefined;
  pools = undefined;
  owner = undefined;
  context = undefined;
});

describe('transaction category live flow', () => {
  it('creates the category and records the original Telegram-style transaction', async () => {
    context = await createPostgresTestContext('transaction_category_live_flow');
    owner = new Pool({ connectionString: context.migratorUrl });
    await seedPrerequisites(owner);
    pools = createDatabasePools(context.roleUrls);

    const agentSystem = createAgentSystem({
      models: {
        lead: { id: 'provider/lead', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
        maker: { id: 'provider/maker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
        checker: { id: 'provider/checker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
        research: { id: 'provider/research', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      },
      queryTools: {},
      queryAgentFactory: () => ({ generate: vi.fn() } as never),
      accountingAgentFactory: () => ({ generate: vi.fn() } as never),
      agentFactory: () => ({ generate: vi.fn() } as never),
    });
    const teamRuntime = createTeamRuntime({ pools, agentSystem });
    const generate = vi.fn(async (prompt: unknown, options?: { toolChoice?: unknown }) => {
      if (options?.toolChoice === 'none') {
        const text = typeof prompt === 'string' && prompt.includes('Eating Out')
          ? 'I recorded IDR 50000 from Bank ABC on 2026-07-16 under Eating Out.'
          : 'I have a checked result ready.';
        return { text };
      }
      const body = typeof prompt === 'string' ? prompt.toLowerCase() : '';
      if (body.includes('add a transaction to bank abc')) {
        await executeDelegate(orchestrator, {
          team: 'accounting',
          request: transactionDraft(
            'Add a transaction to Bank ABC.',
            { paymentAccountName: 'Bank ABC' },
          ),
        });
        return { text: 'I need the transaction details.' };
      }
      if (body.includes('50k idr')) {
        await executeDelegate(orchestrator, {
          team: 'accounting',
          request: transactionDraft(
            'Record IDR 50000 from Bank ABC under eating out yesterday.',
            {
              amount: '50000',
              currency: 'IDR',
              occurredOn: 'yesterday',
              categoryName: 'eating out',
            },
          ),
        });
        return { text: 'I found the transaction details.' };
      }
      await executeDelegate(orchestrator, { team: 'accounting', request: chartDraft() });
      return { text: 'I have a category change ready.' };
    });
    const orchestrator = new OrchestratorAgent({
      model: { id: 'provider/orchestrator', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      agentFactory: (config) => ({ ...config, generate }) as never,
      teams: [accountingTeamDefinition],
      teamRuntime,
    });
    mastra = createMastra(
      context.roleUrls.memory,
      {},
      [],
      { 'orchestrator-loop': createOrchestratorLoopWorkflow(orchestrator) },
    );

    const transcript: string[] = [];
    const first = await runMessage('i wanna add a transaction to bank abc', 1);
    transcript.push(`Adam: i wanna add a transaction to bank abc\nPlus One Testing: ${first.body}`);
    expect(first.body).toContain('Groceries');
    expect(first.body).toContain('add a new category');

    const second = await runMessage('50k idr, eating out, yesterday', 2);
    transcript.push(`Adam: 50k idr, eating out, yesterday\nPlus One Testing: ${second.body}`);
    expect(second.body).toContain('I don’t have a "eating out" category yet.');
    expect(second.body).toContain('Existing transaction categories include Groceries.');

    const third = await runMessage('add new', 3);
    transcript.push(`Adam: add new\nPlus One Testing: ${third.body}`);
    expect(third.body).toContain('Eating Out');
    expect(third.body).toContain('IDR 50000');
    expect(third.body).toContain('Bank ABC');
    expect(third.body).toContain('dated yesterday');
    expect(third.body).toContain('Would you like me to proceed?');

    const fourth = await runMessage('ok', 4);
    transcript.push(`Adam: ok\nPlus One Testing: ${fourth.body}`);
    expect(fourth.body).toBe(
      'I added Eating Out as a new spending category and recorded IDR 50000 from Bank ABC on 2026-07-16 under Eating Out.',
    );

    expect((await owner.query<{ name: string; native_currency: string }>(
      `SELECT name, native_currency FROM accounting.accounts
       WHERE household_id = (SELECT id FROM operations.households WHERE household_id = $1)
         AND name = 'Eating Out'`,
      [ids.householdId],
    )).rows).toEqual([{ name: 'Eating Out', native_currency: 'IDR' }]);
    expect((await owner.query<{ occurred_on: string; transaction_currency: string }>(
      `SELECT occurred_on::text, transaction_currency FROM accounting.journals
       WHERE household_id = (SELECT id FROM operations.households WHERE household_id = $1)`,
      [ids.householdId],
    )).rows).toEqual([{ occurred_on: '2026-07-16', transaction_currency: 'IDR' }]);
    expect((await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM accounting.postings
       WHERE household_id = (SELECT id FROM operations.households WHERE household_id = $1)`,
      [ids.householdId],
    )).rows).toEqual([{ count: '2' }]);

    console.info(`\n${transcript.join('\n\n')}\n`);
  });
});

async function runMessage(body: string, ordinal: number) {
  return runOrchestratorLoop({
    workflow: mastra!.getWorkflow('orchestrator-loop'),
    message: message(body, ordinal),
  });
}

function message(body: string, ordinal: number) {
  return InboundChannelMessageSchemaV1.parse({
    schemaName: 'inbound-channel-message',
    schemaVersion: 1,
    conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    householdId: ids.householdId,
    channel: 'telegram',
    externalMessageId: `telegram:42:${ordinal}`,
    receivedAt: '2026-07-16T16:28:00.000Z',
    speaker: { principalRef: 'telegram:user:42', displayName: 'Adam' },
    body,
    attachments: [],
    metadata: { destination: { chatId: 'telegram-chat-42' } },
  });
}

function transactionDraft(instruction: string, known: Record<string, string>): JsonValue {
  return {
    schemaName: 'accounting-lead-request',
    schemaVersion: 1,
    intent: 'transaction_capture',
    request: {
      schemaName: 'transaction-capture-request-draft',
      schemaVersion: 1,
      instruction,
      known,
    },
  };
}

function chartDraft(): JsonValue {
  return {
    schemaName: 'accounting-lead-request',
    schemaVersion: 1,
    intent: 'chart_of_accounts',
    request: {
      schemaName: 'chart-work-request-draft',
      schemaVersion: 1,
      action: 'create_account',
      instruction: 'Add Eating Out as a new spending category.',
      known: {
        accountName: 'Eating Out',
        accountingClass: 'expense',
        normalBalance: 'debit',
        nativeCurrency: 'IDR',
      },
    },
  };
}

async function executeDelegate(
  orchestrator: OrchestratorAgent,
  input: JsonValue,
): Promise<unknown> {
  const execute = orchestrator.agentTools.delegateTeam.execute as unknown as (
    value: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return TeamResultEnvelopeSchemaV2.parse(await execute(input, {}));
}

async function seedPrerequisites(pool: Pool): Promise<void> {
  const household = await pool.query<{ id: string }>(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1, 'IDR', 'Asia/Shanghai') RETURNING id::text`,
    [ids.householdId],
  );
  const book = await pool.query<{ id: string }>(
    `INSERT INTO accounting.books (book_id, household_id, name)
     VALUES ($1, $2, 'Household Book') RETURNING id::text`,
    [ids.bookId, household.rows[0]!.id],
  );
  await pool.query(
    `INSERT INTO accounting.book_configurations
       (configuration_id, household_id, book_id, reporting_currency, effective_from)
     VALUES ('bookconfig_01JNZQ4A9B8C7D6E5F4G3H2J1K', $1, $2, 'IDR', DATE '2026-01-01')`,
    [household.rows[0]!.id, book.rows[0]!.id],
  );
  await pool.query(
    `INSERT INTO accounting.periods
       (period_id, household_id, book_id, period_start, period_end)
     VALUES ('period_01JNZQ4A9B8C7D6E5F4G3H2J1K', $1, $2, DATE '2026-07-01', DATE '2026-07-31')`,
    [household.rows[0]!.id, book.rows[0]!.id],
  );
  await pool.query(
    `INSERT INTO accounting.accounts
       (account_id, household_id, book_id, name, accounting_class, normal_balance, native_currency)
     VALUES
       ($1, $3, $4, 'Bank ABC', 'asset', 'debit', 'IDR'),
       ($2, $3, $4, 'Groceries', 'expense', 'debit', 'IDR')`,
    [ids.paymentAccountId, ids.categoryAccountId, household.rows[0]!.id, book.rows[0]!.id],
  );
}
