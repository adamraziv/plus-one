import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { InboundChannelMessageSchemaV1 } from '@plus-one/contracts';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';
import {
  startProductionGatewayServer,
  type ProductionGatewayServerHandle,
} from '../helpers/production-gateway-server.js';

const realModelEnabled = process.env.RUN_REAL_MODEL_SMOKE === '1';

describe.skipIf(!realModelEnabled)('configured real-model accounting smoke', () => {
  it('retains a same-turn date while creating a missing expense category', async () => {
    const context = await createPostgresTestContext('real_model_category_continuation');
    const owner = new Pool({ connectionString: context.migratorUrl, max: 1 });
    let server: ProductionGatewayServerHandle | undefined;
    try {
      await seedAccountingState(owner);
      const before = await effectCounts(owner);
      server = await startProductionGatewayServer({
        env: {
          ...databaseEnvironment(context),
          ORCHESTRATOR_TURN_TIMEOUT_MS: '180000',
          TELEGRAM_BOT_TOKEN: undefined,
          TELEGRAM_WEBHOOK_URL: undefined,
          TELEGRAM_WEBHOOK_SECRET: undefined,
          TELEGRAM_API_BASE_URL: undefined,
        },
        useConfiguredModel: true,
        timeoutMs: 60_000,
      });

      const details = await sendMessage(
        server,
        'I paid 23.75 usd from my Everyday Checking for dog treats',
        1,
      );
      const proposal = await sendMessage(
        server,
        'It was yesterday — please make Dog Treats a new spending category too.',
        2,
      );
      const confirmed = await sendMessage(server, 'yes, go ahead please', 3);

      console.info(JSON.stringify({
        details: details.body,
        proposal: proposal.body,
        confirmed: confirmed.body,
      }));

      expect(details.status).toBe(200);
      expect(details.body).toMatch(/date|when/i);
      expect(details.body).toMatch(/dog treats/i);
      expectNoImplementationDetails(details.body);
      expect(proposal.status).toBe(200);
      expect(proposal.body).toMatch(/Dog Treats/i);
      expect(proposal.body).toContain('USD');
      expect(proposal.body).toContain('23.75');
      expect(proposal.body).toMatch(/Everyday Checking/i);
      expect(proposal.body).toMatch(/yesterday/i);
      expect(proposal.body).toMatch(/proceed|confirm|go ahead/i);
      expectNoImplementationDetails(proposal.body);
      expect(confirmed.status).toBe(200);
      expect(confirmed.body).toMatch(/recorded|completed|logged/i);
      expect(confirmed.body).toMatch(/Dog Treats/i);
      expect(confirmed.body).toMatch(/category/i);
      expect(confirmed.body).not.toMatch(/Dog Treats["']?\s+(?:expense\s+)?account/i);
      expect(confirmed.body).toMatch(/(?:USD\s*23\.75|\$23\.75)/i);
      expect(confirmed.body).toMatch(/Everyday Checking/i);
      expect(confirmed.body).toMatch(/2026-07-24|July 24, 2026/i);
      expectNoImplementationDetails(confirmed.body);
      await expectCommittedState(owner, before);

      const reset = await sendMessage(server, '/new', 4);
      expect(reset.status).toBe(200);
      expect(reset.body).toBe('Started a new thread.');
      expect(reset.conversationId).toMatch(/^conversation_/);
      const query = await sendMessage(
        server,
        'Could you show me the dog treats transaction?',
        5,
        reset.conversationId,
      );
      console.info(JSON.stringify({ query: query.body }));
      expect(query.status).toBe(200);
      expect(query.body).toMatch(/Dog Treats/i);
      expect(query.body).toMatch(/(?:USD\s*23\.75|\$23\.75)/i);
      expect(query.body).toMatch(/Everyday Checking/i);
      expect(query.body).toMatch(/2026-07-24|July 24, 2026/i);
      expect(query.body).not.toMatch(/debit(?:ed)?\s+from (?:your )?Everyday Checking/i);
      expectNoImplementationDetails(query.body);
      await expectCommittedState(owner, before);
    } finally {
      await server?.stop();
      await owner.end();
      await context.cleanup();
    }
  }, 300_000);
});

async function seedAccountingState(pool: Pool): Promise<void> {
  const household = await pool.query<{ id: string }>(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1, 'USD', 'America/Los_Angeles') RETURNING id::text`,
    [householdId],
  );
  const book = await pool.query<{ id: string }>(
    `INSERT INTO accounting.books (book_id, household_id, name)
     VALUES ($1, $2, 'Household Book') RETURNING id::text`,
    [bookId, household.rows[0]!.id],
  );
  await pool.query(
    `INSERT INTO accounting.book_configurations
       (configuration_id, household_id, book_id, reporting_currency, effective_from)
     VALUES ($1, $2, $3, 'USD', DATE '2026-01-01')`,
    [bookConfigurationId, household.rows[0]!.id, book.rows[0]!.id],
  );
  await pool.query(
    `INSERT INTO accounting.periods
       (period_id, household_id, book_id, period_start, period_end)
     VALUES ($1, $2, $3, DATE '2026-07-01', DATE '2026-07-31')`,
    [periodId, household.rows[0]!.id, book.rows[0]!.id],
  );
  await pool.query(
    `INSERT INTO accounting.accounts
       (account_id, household_id, book_id, name, accounting_class, normal_balance, native_currency)
     VALUES
       ($1, $3, $4, 'Everyday Checking', 'asset', 'debit', 'USD'),
       ($2, $3, $4, 'Groceries', 'expense', 'debit', 'USD')`,
    [paymentAccountId, existingCategoryId, household.rows[0]!.id, book.rows[0]!.id],
  );
}

async function sendMessage(
  server: ProductionGatewayServerHandle,
  body: string,
  ordinal: number,
  targetConversationId = conversationId,
): Promise<{ status: number; body: string; conversationId: string }> {
  const response = await fetch(`${server.baseUrl}/plus-one/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(InboundChannelMessageSchemaV1.parse({
      schemaName: 'inbound-channel-message',
      schemaVersion: 1,
      conversationId: targetConversationId,
      householdId,
      channel: 'telegram',
      externalMessageId: `telegram:real-model-smoke:${ordinal}`,
      receivedAt: '2026-07-25T07:30:00.000Z',
      speaker: { principalRef: 'telegram:user:real-model-smoke', displayName: 'Adam' },
      body,
      attachments: [],
      metadata: { destination: { chatId: 'telegram-real-model-smoke' } },
    })),
  });
  const result = await response.json() as { body?: string; conversationId?: string };
  return {
    status: response.status,
    body: result.body ?? '',
    conversationId: result.conversationId ?? targetConversationId,
  };
}

async function effectCounts(pool: Pool): Promise<{
  accounts: number;
  journals: number;
  postings: number;
  commands: number;
  receipts: number;
  readbacks: number;
  confirmations: number;
}> {
  const result = await pool.query<{
    accounts: number;
    journals: number;
    postings: number;
    commands: number;
    receipts: number;
    readbacks: number;
    confirmations: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM accounting.accounts) AS accounts,
       (SELECT count(*)::int FROM accounting.journals) AS journals,
       (SELECT count(*)::int FROM accounting.postings) AS postings,
       (SELECT count(*)::int FROM operations.mutation_commands) AS commands,
       (SELECT count(*)::int FROM operations.mutation_receipts) AS receipts,
       (SELECT count(*)::int FROM operations.mutation_readbacks) AS readbacks,
       (SELECT count(*)::int FROM operations.external_confirmations) AS confirmations`,
  );
  return result.rows[0]!;
}

async function expectCommittedState(
  pool: Pool,
  before: Awaited<ReturnType<typeof effectCounts>>,
): Promise<void> {
  expect(await effectCounts(pool)).toEqual({
    accounts: before.accounts + 1,
    journals: before.journals + 1,
    postings: before.postings + 2,
    commands: before.commands + 2,
    receipts: before.receipts + 2,
    readbacks: before.readbacks + 2,
    confirmations: before.confirmations + 1,
  });
  expect((await pool.query<{
    name: string;
    accounting_class: string;
    normal_balance: string;
    native_currency: string;
  }>(
    `SELECT name, accounting_class, normal_balance, native_currency
     FROM accounting.accounts
     WHERE household_id = (SELECT id FROM operations.households WHERE household_id = $1)
       AND lower(name) = 'dog treats'`,
    [householdId],
  )).rows).toEqual([{
    name: 'Dog Treats',
    accounting_class: 'expense',
    normal_balance: 'debit',
    native_currency: 'USD',
  }]);
  expect((await pool.query<{
    occurred_on: string;
    transaction_currency: string;
    transaction_amount: string;
    accounts: string[];
    directions: Record<string, string>;
  }>(
    `SELECT journal.occurred_on::text, journal.transaction_currency,
       max(posting.transaction_amount)::text AS transaction_amount,
       array_agg(account.name ORDER BY account.name) AS accounts,
       jsonb_object_agg(account.name, posting.direction) AS directions
     FROM accounting.journals journal
     JOIN accounting.postings posting ON posting.journal_id = journal.id
     JOIN accounting.accounts account ON account.id = posting.account_id
     GROUP BY journal.id, journal.occurred_on, journal.transaction_currency`,
  )).rows).toEqual([{
    occurred_on: '2026-07-24',
    transaction_currency: 'USD',
    transaction_amount: '23.750000000000',
    accounts: ['Dog Treats', 'Everyday Checking'],
    directions: { 'Dog Treats': 'debit', 'Everyday Checking': 'credit' },
  }]);
}

function expectNoImplementationDetails(body: string): void {
  expect(body).not.toMatch(
    /safely|internal|schema|readback|native_currency|QueryResult|team status|maker|checker|reporting\./i,
  );
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

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const conversationId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const bookId = 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const bookConfigurationId = 'bookconfig_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const periodId = 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const paymentAccountId = 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const existingCategoryId = 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K';
