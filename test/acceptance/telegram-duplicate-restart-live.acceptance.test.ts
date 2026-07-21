import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';
import {
  startProductionGatewayServer,
  type ProductionGatewayServerHandle,
} from '../helpers/production-gateway-server.js';
import {
  startTelegramApiTestServer,
  type TelegramApiTestServer,
} from '../helpers/telegram-api-test-server.js';
import type {
  OpenAiCompatibleTestResponder,
} from '../helpers/openai-compatible-test-server.js';

const ids = {
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  paymentAccountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  categoryAccountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
} as const;

const telegramUpdate = {
  update_id: 9_001,
  message: {
    message_id: 701,
    date: Date.parse('2026-07-20T08:00:00.000Z') / 1_000,
    text: 'record idr 10000 from bank abc under groceries today',
    chat: { id: 4_242, type: 'private' },
    from: { id: 42, is_bot: false, first_name: 'Adam' },
  },
} as const;

let context: PostgresTestContext | undefined;
let owner: Pool | undefined;
let gateway: ProductionGatewayServerHandle | undefined;
let restartedGateway: ProductionGatewayServerHandle | undefined;
let telegram: TelegramApiTestServer | undefined;

afterEach(async () => {
  await restartedGateway?.stop();
  await gateway?.stop();
  await telegram?.close();
  await owner?.end();
  await context?.cleanup();
  restartedGateway = undefined;
  gateway = undefined;
  telegram = undefined;
  owner = undefined;
  context = undefined;
});

describe('Telegram duplicate delivery through a live restarted production gateway', () => {
  it('commits and delivers once when Telegram replays the same update before and after restart', async () => {
    context = await createPostgresTestContext('telegram_duplicate_restart');
    owner = new Pool({ connectionString: context.migratorUrl, max: 1 });
    await seedAccountingAndPrincipal(owner);
    telegram = await startTelegramApiTestServer();
    const env = gatewayEnvironment(context, telegram.baseUrl);

    gateway = await startProductionGatewayServer({
      env,
      modelResponder: transactionResponder,
    });
    expect(methodCount(telegram, 'setWebhook')).toBe(1);

    const first = await postTelegramUpdate(gateway);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ status: 'delivered', sent: true });
    expect(gateway.modelRequests().some((request) => hasFunctionTool(request.body, 'delegateTeam'))).toBe(true);
    expect(telegram.requests().some((request) =>
      request.method === 'sendMessage'
      && typeof request.body.text === 'string'
      && /recorded IDR 10000.*Bank ABC.*2026-07-20.*Groceries/i.test(
        request.body.text.replaceAll('\\', ''),
      ))).toBe(true);
    await expectPersistedExactlyOnce(owner);

    const firstModelCallCount = gateway.modelRequests().length;
    const firstTelegramCallCount = telegram.requests().length;
    const duplicate = await postTelegramUpdate(gateway);
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toEqual({ status: 'duplicate' });
    expect(gateway.modelRequests()).toHaveLength(firstModelCallCount);
    expect(telegram.requests()).toHaveLength(firstTelegramCallCount);
    await expectPersistedExactlyOnce(owner);

    await gateway.stop();
    gateway = undefined;
    restartedGateway = await startProductionGatewayServer({
      env,
      modelResponder: transactionResponder,
    });
    expect(restartedGateway.modelRequests()).toHaveLength(0);
    expect(methodCount(telegram, 'setWebhook')).toBe(2);
    const restartTelegramCallCount = telegram.requests().length;

    const replayAfterRestart = await postTelegramUpdate(restartedGateway);
    expect(replayAfterRestart.status).toBe(200);
    await expect(replayAfterRestart.json()).resolves.toEqual({ status: 'duplicate' });
    expect(restartedGateway.modelRequests()).toHaveLength(0);
    expect(telegram.requests()).toHaveLength(restartTelegramCallCount);
    await expectPersistedExactlyOnce(owner);
  }, 120_000);
});

const transactionResponder: OpenAiCompatibleTestResponder = ({ body }) => {
  if (hasFunctionTool(body, 'submitResult')) return undefined;
  const userText = latestUserText(body);
  if (hasFunctionTool(body, 'delegateTeam') && !hasToolResult(body)) {
    return {
      finishReason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'delegate-team-telegram-duplicate-transaction',
          type: 'function',
          function: {
            name: 'delegateTeam',
            arguments: JSON.stringify({
              team: 'accounting',
              request: {
                schemaName: 'accounting-lead-request',
                schemaVersion: 1,
                intent: 'transaction_capture',
                request: {
                  schemaName: 'transaction-capture-request-draft',
                  schemaVersion: 1,
                  instruction: 'Record the requested transaction.',
                  known: {
                    amount: '10000',
                    currency: 'IDR',
                    occurredOn: 'today',
                    paymentAccountName: 'Bank ABC',
                    categoryName: 'Groceries',
                  },
                },
              },
            }),
          },
        }],
      },
    };
  }
  if (userText.includes('Safe checked context:')
    && userText.includes('IDR 10000')
    && userText.includes('Bank ABC')
    && userText.includes('Groceries')
    && userText.includes('2026-07-20')) {
    return {
      finishReason: 'stop',
      message: {
        role: 'assistant',
        content: 'I recorded IDR 10000 from Bank ABC on 2026-07-20 under Groceries.',
      },
    };
  }
  return {
    finishReason: 'stop',
    message: { role: 'assistant', content: 'I completed the checked accounting request.' },
  };
};

async function seedAccountingAndPrincipal(pool: Pool): Promise<void> {
  const household = await pool.query<{ id: string }>(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1, 'IDR', 'Asia/Shanghai') RETURNING id::text`,
    [ids.householdId],
  );
  const householdKey = household.rows[0]!.id;
  const book = await pool.query<{ id: string }>(
    `INSERT INTO accounting.books (book_id, household_id, name)
     VALUES ($1, $2, 'Household Book') RETURNING id::text`,
    [ids.bookId, householdKey],
  );
  await pool.query(
    `INSERT INTO accounting.book_configurations
       (configuration_id, household_id, book_id, reporting_currency, effective_from)
     VALUES ('bookconfig_01JNZQ4A9B8C7D6E5F4G3H2J1K', $1, $2, 'IDR', DATE '2026-01-01')`,
    [householdKey, book.rows[0]!.id],
  );
  await pool.query(
    `INSERT INTO accounting.periods
       (period_id, household_id, book_id, period_start, period_end)
     VALUES ('period_01JNZQ4A9B8C7D6E5F4G3H2J1K', $1, $2, DATE '2026-07-01', DATE '2026-07-31')`,
    [householdKey, book.rows[0]!.id],
  );
  await pool.query(
    `INSERT INTO accounting.accounts
       (account_id, household_id, book_id, name, accounting_class, normal_balance, native_currency)
     VALUES
       ($1, $3, $4, 'Bank ABC', 'asset', 'debit', 'IDR'),
       ($2, $3, $4, 'Groceries', 'expense', 'debit', 'IDR')`,
    [ids.paymentAccountId, ids.categoryAccountId, householdKey, book.rows[0]!.id],
  );
  await pool.query(
    `INSERT INTO operations.channel_principals
       (channel, external_user_id, external_chat_id, household_id,
        display_name, username, approved_by, metadata)
     VALUES ('telegram', '42', '4242', $1, 'Adam', 'adam', 'acceptance-test', '{}')`,
    [householdKey],
  );
}

async function expectPersistedExactlyOnce(pool: Pool): Promise<void> {
  const counts = await pool.query<{
    inbound_messages: number;
    conversations: number;
    deliveries: number;
    delivered: number;
    journals: number;
    postings: number;
    commands: number;
    receipts: number;
    readbacks: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM operations.channel_messages WHERE direction = 'inbound') AS inbound_messages,
       (SELECT count(*)::int FROM operations.channel_conversations) AS conversations,
       (SELECT count(*)::int FROM operations.outbound_deliveries) AS deliveries,
       (SELECT count(*)::int FROM operations.outbound_deliveries WHERE status = 'delivered') AS delivered,
       (SELECT count(*)::int FROM accounting.journals) AS journals,
       (SELECT count(*)::int FROM accounting.postings) AS postings,
       (SELECT count(*)::int FROM operations.mutation_commands WHERE status = 'readback_verified') AS commands,
       (SELECT count(*)::int FROM operations.mutation_receipts) AS receipts,
       (SELECT count(*)::int FROM operations.mutation_readbacks WHERE ok) AS readbacks`,
  );
  expect(counts.rows).toEqual([{
    inbound_messages: 1,
    conversations: 1,
    deliveries: 1,
    delivered: 1,
    journals: 1,
    postings: 2,
    commands: 1,
    receipts: 1,
    readbacks: 1,
  }]);
  expect((await pool.query<{
    occurred_on: string;
    transaction_currency: string;
    transaction_amount: string;
    payment_account: string;
    category_account: string;
  }>(
    `SELECT journal.occurred_on::text, journal.transaction_currency,
       max(posting.transaction_amount)::text AS transaction_amount,
       max(account.name) FILTER (WHERE account.accounting_class = 'asset') AS payment_account,
       max(account.name) FILTER (WHERE account.accounting_class = 'expense') AS category_account
     FROM accounting.journals journal
     JOIN accounting.postings posting ON posting.journal_id = journal.id
     JOIN accounting.accounts account ON account.id = posting.account_id
     GROUP BY journal.id, journal.occurred_on, journal.transaction_currency`,
  )).rows).toEqual([{
    occurred_on: '2026-07-20',
    transaction_currency: 'IDR',
    transaction_amount: '10000.000000000000',
    payment_account: 'Bank ABC',
    category_account: 'Groceries',
  }]);
}

async function postTelegramUpdate(server: ProductionGatewayServerHandle): Promise<Response> {
  return fetch(`${server.baseUrl}/telegram/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': 'webhook-secret',
    },
    body: JSON.stringify(telegramUpdate),
  });
}

function gatewayEnvironment(
  testContext: PostgresTestContext,
  telegramApiBaseUrl: string,
): NodeJS.ProcessEnv {
  return {
    DATABASE_MIGRATOR_URL: testContext.migratorUrl,
    DATABASE_ACCOUNTING_URL: testContext.roleUrls.accounting,
    DATABASE_PLANNING_URL: testContext.roleUrls.planning,
    DATABASE_OPERATIONS_URL: testContext.roleUrls.operations,
    DATABASE_QUERY_URL: testContext.roleUrls.query,
    DATABASE_MEMORY_URL: testContext.roleUrls.memory,
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_WEBHOOK_URL: 'https://plus-one.example.test/telegram/webhook',
    TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
    TELEGRAM_API_BASE_URL: telegramApiBaseUrl,
  };
}

function methodCount(server: TelegramApiTestServer, method: string): number {
  return server.requests().filter((request) => request.method === method).length;
}

function hasFunctionTool(body: Record<string, unknown>, name: string): boolean {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.some((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return false;
    const definition = candidate.function;
    return typeof definition === 'object'
      && definition !== null
      && !Array.isArray(definition)
      && definition.name === name;
  });
}

function hasToolResult(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.some((candidate) => typeof candidate === 'object'
    && candidate !== null
    && !Array.isArray(candidate)
    && candidate.role === 'tool');
}

function latestUserText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const candidate of [...messages].reverse()) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue;
    if (candidate.role !== 'user') continue;
    return textContent(candidate.content);
  }
  return '';
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textContent).join(' ');
  if (typeof value !== 'object' || value === null) return '';
  return Object.values(value).map(textContent).join(' ');
}
