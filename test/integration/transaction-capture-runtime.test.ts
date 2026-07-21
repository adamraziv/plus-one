import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import {
  accountingTeamDefinition,
} from '@plus-one/accounting';
import {
  InboundChannelMessageSchemaV1,
  QueryResultSchemaV1,
} from '@plus-one/contracts';
import { closeDatabasePools, createDatabasePools } from '@plus-one/database';
import { createAgentSystem } from '../../apps/engine/src/agent-catalog.js';
import { createDefaultQueryTools } from '../../apps/engine/src/query-tools.js';
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

afterEach(async () => {
  if (pools !== undefined) await closeDatabasePools(pools);
  await owner?.end();
  await context?.cleanup();
  pools = undefined;
  owner = undefined;
  context = undefined;
});

describe('production transaction capture runtime', () => {
  it('posts a relative-date transaction through the real checked mutation path', async () => {
    context = await createPostgresTestContext('transaction_capture_runtime');
    owner = new Pool({ connectionString: context.migratorUrl });
    await seedPrerequisites(owner);
    pools = createDatabasePools(context.roleUrls);

    const queryTools = createDefaultQueryTools(pools);
    const agentSystem = createAgentSystem({
      models: {
        lead: { id: 'provider/lead', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
        maker: { id: 'provider/maker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
        checker: { id: 'provider/checker', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
        research: { id: 'provider/research', endpoint: 'https://llm.example.test/v1', apiKey: 'test-api-key' },
      },
      queryTools,
      queryAgentFactory: () => ({ generate: vi.fn() } as never),
      accountingAgentFactory: () => ({ generate: vi.fn() } as never),
      agentFactory: () => ({ generate: vi.fn() } as never),
    });
    const runtime = createTeamRuntime({ pools, agentSystem });

    const result = await runtime.runTeamLead({
      message: message('50k idr, eating out, yesterday'),
      team: accountingTeamDefinition,
      request: {
        schemaName: 'accounting-lead-request',
        schemaVersion: 1,
        intent: 'transaction_capture',
        request: {
          schemaName: 'transaction-capture-request-draft',
          schemaVersion: 1,
          instruction: 'Record IDR 50000 from Bank ABC under Groceries yesterday.',
          known: {
            amount: '50000',
            currency: 'IDR',
            paymentAccountName: 'Bank ABC',
            categoryName: 'Groceries',
            occurredOn: 'yesterday',
          },
        },
      },
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: 'verified',
      effect: { state: 'persisted', readback: { ok: true } },
    });
    expect((await owner.query<{ occurred_on: string; transaction_currency: string }>(
      'SELECT occurred_on::text, transaction_currency FROM accounting.journals',
    )).rows).toEqual([{ occurred_on: '2026-07-16', transaction_currency: 'IDR' }]);
    const categorizedTransactions = queryTools.query_categorized_transactions;
    if (categorizedTransactions?.execute === undefined) {
      throw new Error('Expected the categorized transactions query tool.');
    }
    const queryResult = QueryResultSchemaV1.parse(
      await categorizedTransactions.execute(
        { householdId: ids.householdId },
        {} as never,
      ),
    );
    expect(queryResult.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        effective_on: '2026-07-16',
        account_name: 'Groceries',
        account_native_amount: '50000.000000000000',
        account_native_currency: 'IDR',
      }),
    ]));
  });
});

function message(body: string) {
  return InboundChannelMessageSchemaV1.parse({
    schemaName: 'inbound-channel-message',
    schemaVersion: 1,
    conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    householdId: ids.householdId,
    channel: 'telegram',
    externalMessageId: 'telegram:42:100',
    receivedAt: '2026-07-17T00:28:00.000Z',
    speaker: { principalRef: 'telegram:user:42' },
    body,
    attachments: [],
    metadata: { destination: { chatId: 'telegram-chat-42' } },
  });
}

async function seedPrerequisites(pool: Pool): Promise<void> {
  const household = await pool.query<{ id: string }>(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1, 'IDR', 'UTC') RETURNING id::text`,
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
