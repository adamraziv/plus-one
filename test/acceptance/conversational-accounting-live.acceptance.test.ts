import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { InboundChannelMessageSchemaV1 } from '@plus-one/contracts';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';
import { startMastraDevServer } from '../helpers/mastra-dev-server.js';
import type {
  OpenAiCompatibleTestResponder,
} from '../helpers/openai-compatible-test-server.js';

let context: PostgresTestContext | undefined;
let server: Awaited<ReturnType<typeof startMastraDevServer>> | undefined;
let owner: Pool | undefined;

afterEach(async () => {
  await server?.stop();
  await owner?.end();
  await context?.cleanup();
  server = undefined;
  owner = undefined;
  context = undefined;
});

describe('conversational accounting through the live service', () => {
  it('routes an incomplete transaction request through the real inbound service', async () => {
    context = await createPostgresTestContext('live_accounting_ingress');
    owner = new Pool({ connectionString: context.migratorUrl, max: 1 });
    await seedAccountingState(owner);
    server = await startMastraDevServer({
      env: databaseEnvironment(context),
      modelResponder: incompleteTransactionResponder,
      rejectOutput: [
        /Peer dependency version mismatch detected/,
        /ERR_MODULE_NOT_FOUND/,
      ],
    });

    const response = await fetch(`${server.baseUrl}/plus-one/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(InboundChannelMessageSchemaV1.parse({
        schemaName: 'inbound-channel-message',
        schemaVersion: 1,
        conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        channel: 'telegram',
        externalMessageId: 'telegram:live-accounting:1',
        receivedAt: '2026-07-20T16:00:00.000Z',
        speaker: { principalRef: 'telegram:user:42', displayName: 'Adam' },
        body: 'i wanna add a transaction to',
        attachments: [],
        metadata: { destination: { chatId: 'telegram-chat-42' } },
      })),
    });
    const result = await response.json() as { body?: string };

    expect(response.status).toBe(200);
    expect(result.body).toMatch(/amount|details|account/i);
    expect(result.body).not.toBe('Test model reply.');
    expect(server.modelRequests().some((request) => hasFunctionTool(request.body, 'delegateTeam'))).toBe(true);
    expect(server.modelRequests().some((request) => hasToolResult(request.body))).toBe(true);
  }, 180_000);

  it('creates Gas and records the retained transaction after one confirmation', async () => {
    context = await createPostgresTestContext('live_gas_transaction');
    owner = new Pool({ connectionString: context.migratorUrl, max: 1 });
    await seedAccountingState(owner);
    server = await startMastraDevServer({
      env: databaseEnvironment(context),
      modelResponder: gasConversationResponder,
      rejectOutput: [
        /Peer dependency version mismatch detected/,
        /ERR_MODULE_NOT_FOUND/,
      ],
    });

    const first = await sendMessage('i wanna add a transaction to', 1);
    expect(first.body).toMatch(/amount/i);
    expect(first.body).toMatch(/account/i);

    const second = await sendMessage('50k idr, today, from bank abc, gas', 2);
    expect(second.body).toContain('I don’t have a "gas" category yet.');
    expect(second.body).toContain('Groceries');
    expect(second.body).toMatch(/add a new category/i);

    const third = await sendMessage('add gas as a new category', 3);
    expect(third.body).toContain('Gas');
    expect(third.body).toContain('IDR 50000');
    expect(third.body).toContain('Bank ABC');
    expect(third.body).toContain('dated today');
    expect(third.body).toMatch(/proceed\?/i);

    const fourth = await sendMessage('ok', 4);
    expect(fourth.body).toMatch(/recorded/i);
    expect(fourth.body).toContain('IDR 50000');
    expect(fourth.body).toContain('Bank ABC');
    expect(fourth.body).toContain('2026-07-20');
    expect(fourth.body).toContain('Gas');
    expectNoImplementationDetails(fourth.body);

    const immediateQuery = await sendMessage('list my transactions', 5);
    expectTransactionQueryResult(immediateQuery.body);

    const reset = await sendMessage('/new', 6);
    expect(reset.body).toBe('Started a new thread.');
    expect(reset.conversationId).toMatch(/^conversation_/);
    expect(reset.conversationId).not.toBe(ids.conversationId);
    if (reset.conversationId === undefined) throw new Error('Expected a fresh conversation id.');

    const freshConversationQuery = await sendMessage(
      'show the transactions in this household',
      7,
      reset.conversationId,
    );
    expectTransactionQueryResult(freshConversationQuery.body);

    const reusedCategory = await sendMessage(
      'record 20k idr today from bank abc under GAS',
      8,
      reset.conversationId,
    );
    expect(reusedCategory.body).toMatch(/recorded/i);
    expect(reusedCategory.body).toContain('IDR 20000');
    expect(reusedCategory.body).toContain('Bank ABC');
    expect(reusedCategory.body).toContain('Gas');
    expect(reusedCategory.body).toContain('2026-07-20');
    expect(reusedCategory.body).not.toMatch(/add a new category|proceed\?/i);
    expectNoImplementationDetails(reusedCategory.body);

    const bothTransactions = await sendMessage(
      'list all my transactions',
      9,
      reset.conversationId,
    );
    expect(bothTransactions.body).toContain('50000');
    expect(bothTransactions.body).toContain('20000');
    expect(bothTransactions.body).toContain('Gas');
    expectNoImplementationDetails(bothTransactions.body);

    expect((await owner.query<{ name: string; native_currency: string }>(
      `SELECT name, native_currency
       FROM accounting.accounts
       WHERE household_id = (SELECT id FROM operations.households WHERE household_id = $1)
         AND lower(name) = 'gas'`,
      [ids.householdId],
    )).rows).toEqual([{ name: 'Gas', native_currency: 'IDR' }]);
    expect((await owner.query<{
      occurred_on: string;
      transaction_currency: string;
      transaction_amount: string;
    }>(
      `SELECT journal.occurred_on::text, journal.transaction_currency,
         posting.transaction_amount::text
       FROM accounting.journals journal
       JOIN accounting.postings posting ON posting.journal_id = journal.id
       JOIN accounting.accounts account ON account.id = posting.account_id
       WHERE journal.household_id = (SELECT id FROM operations.households WHERE household_id = $1)
         AND lower(account.name) = 'gas'
       ORDER BY posting.transaction_amount DESC`,
      [ids.householdId],
    )).rows).toEqual([
      { occurred_on: '2026-07-20', transaction_currency: 'IDR', transaction_amount: '50000.000000000000' },
      { occurred_on: '2026-07-20', transaction_currency: 'IDR', transaction_amount: '20000.000000000000' },
    ]);
    expect((await owner.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM accounting.postings
       WHERE household_id = (SELECT id FROM operations.households WHERE household_id = $1)`,
      [ids.householdId],
    )).rows).toEqual([{ count: 4 }]);
    expect((await owner.query<{
      commands: number;
      receipts: number;
      readbacks: number;
      confirmations: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM operations.mutation_commands WHERE status = 'readback_verified') AS commands,
         (SELECT count(*)::int FROM operations.mutation_receipts) AS receipts,
         (SELECT count(*)::int FROM operations.mutation_readbacks WHERE ok) AS readbacks,
         (SELECT count(*)::int FROM operations.external_confirmations) AS confirmations`,
    )).rows).toEqual([{ commands: 3, receipts: 3, readbacks: 3, confirmations: 1 }]);
    expect(server.modelRequests().filter((request) =>
      hasFunctionTool(request.body, 'delegateTeam')
      && latestUserText(request.body).toLowerCase().includes('transaction')).length).toBeGreaterThanOrEqual(2);
  }, 180_000);

  it('retains transaction details supplied while creating a missing Foods category', async () => {
    context = await createPostgresTestContext('live_foods_combined_continuation');
    owner = new Pool({ connectionString: context.migratorUrl, max: 1 });
    await seedAccountingState(owner);
    server = await startMastraDevServer({
      env: databaseEnvironment(context),
      modelResponder: foodsCombinedContinuationResponder,
      rejectOutput: [
        /Peer dependency version mismatch detected/,
        /ERR_MODULE_NOT_FOUND/,
      ],
    });

    const initialQuery = await sendMessage('can u check my transactions?', 1);
    const details = await sendMessage('spent 20k idr out of my bank abc account for foods', 2);
    const proposal = await sendMessage('yesterday. add foods as a new category', 3);
    const confirmed = await sendMessage('yes', 4);
    const queried = await sendMessage('list my transactions', 5);

    expect(initialQuery.body).toMatch(/no transactions|aren't any transactions/i);
    expect(details.body).toMatch(/what date|on what date/i);
    expect(details.body).toContain('I don’t have a "foods" category yet.');
    expect(proposal.body).toContain('Foods');
    expect(proposal.body).toContain('IDR 20000');
    expect(proposal.body).toContain('Bank ABC');
    expect(proposal.body).toContain('dated yesterday');
    expect(proposal.body).toMatch(/proceed\?/i);
    expect(confirmed.body).toMatch(/recorded/i);
    expect(confirmed.body).toContain('IDR 20000');
    expect(confirmed.body).toContain('Bank ABC');
    expect(confirmed.body).toContain('Foods');
    expect(confirmed.body).toContain('2026-07-19');
    expectNoImplementationDetails(confirmed.body);
    expect(queried.body).toContain('IDR 20000');
    expect(queried.body).toContain('Bank ABC');
    expect(queried.body).toContain('Foods');
    expect(queried.body).toContain('2026-07-19');
    expectNoImplementationDetails(queried.body);

    expect((await owner.query<{ name: string; native_currency: string }>(
      `SELECT name, native_currency
       FROM accounting.accounts
       WHERE household_id = (SELECT id FROM operations.households WHERE household_id = $1)
         AND lower(name) = 'foods'`,
      [ids.householdId],
    )).rows).toEqual([{ name: 'Foods', native_currency: 'IDR' }]);
    expect((await owner.query<{
      occurred_on: string;
      transaction_currency: string;
      transaction_amount: string;
    }>(
      `SELECT journal.occurred_on::text, journal.transaction_currency,
         posting.transaction_amount::text
       FROM accounting.journals journal
       JOIN accounting.postings posting ON posting.journal_id = journal.id
       JOIN accounting.accounts account ON account.id = posting.account_id
       WHERE journal.household_id = (SELECT id FROM operations.households WHERE household_id = $1)
         AND lower(account.name) = 'foods'`,
      [ids.householdId],
    )).rows).toEqual([{
      occurred_on: '2026-07-19',
      transaction_currency: 'IDR',
      transaction_amount: '20000.000000000000',
    }]);
    expect((await owner.query<{
      commands: number;
      receipts: number;
      readbacks: number;
      confirmations: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM operations.mutation_commands WHERE status = 'readback_verified') AS commands,
         (SELECT count(*)::int FROM operations.mutation_receipts) AS receipts,
         (SELECT count(*)::int FROM operations.mutation_readbacks WHERE ok) AS readbacks,
         (SELECT count(*)::int FROM operations.external_confirmations) AS confirmations`,
    )).rows).toEqual([{ commands: 2, receipts: 2, readbacks: 2, confirmations: 1 }]);
  }, 180_000);

  it('creates Wallet once across confirmation replay and a later semantic retry', async () => {
    context = await createPostgresTestContext('live_wallet_account');
    owner = new Pool({ connectionString: context.migratorUrl, max: 1 });
    await seedAccountingState(owner);
    server = await startMastraDevServer({
      env: databaseEnvironment(context),
      modelResponder: accountConversationResponder,
      rejectOutput: [
        /Peer dependency version mismatch detected/,
        /ERR_MODULE_NOT_FOUND/,
      ],
    });

    const proposal = await sendMessage('please create Wallet as an IDR asset account', 1);
    expect(proposal.body).toContain('Wallet');
    expect(proposal.body).toContain('IDR');
    expect(proposal.body).toMatch(/asset/i);
    expect(proposal.body).toMatch(/debit/i);
    expect(proposal.body).toMatch(/proceed\?/i);
    expect(proposal.body).not.toMatch(/created|added|saved|succeeded/i);

    const confirmed = await sendMessage('ok', 2);
    expect(confirmed.body).toMatch(/added|created/i);
    expect(confirmed.body).toContain('Wallet');
    expectNoImplementationDetails(confirmed.body);

    const replayedConfirmation = await sendMessage('ok', 2);
    expect(replayedConfirmation.body).not.toMatch(/added|created|saved|succeeded/i);

    const immediateQuery = await sendMessage('list my accounts', 3);
    expectAccountQueryResult(immediateQuery.body);

    const reset = await sendMessage('/new', 4);
    expect(reset.body).toBe('Started a new thread.');
    const freshConversationId = reset.conversationId;
    expect(freshConversationId).toMatch(/^conversation_/);
    if (freshConversationId === undefined) throw new Error('Expected a fresh conversation id.');

    const freshQuery = await sendMessage('show the household accounts', 5, freshConversationId);
    expectAccountQueryResult(freshQuery.body);

    const retry = await sendMessage(
      'add an IDR asset account called wallet',
      6,
      freshConversationId,
    );
    expect(retry.body).toContain('Wallet');
    expect(retry.body).toMatch(/already exists/i);
    expect(retry.body).toContain('No new account was created.');
    expect(retry.body).not.toMatch(/proceed\?|added|saved|succeeded/i);
    expectNoImplementationDetails(retry.body);
    const retryConfirmation = await sendMessage('ok', 7, freshConversationId);
    expectNoImplementationDetails(retryConfirmation.body);

    expect((await owner.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM accounting.accounts
       WHERE household_id = (SELECT id FROM operations.households WHERE household_id = $1)
         AND lower(name) = 'wallet'`,
      [ids.householdId],
    )).rows).toEqual([{ count: 1 }]);
    expect((await owner.query<{
      commands: number;
      receipts: number;
      readbacks: number;
      confirmations: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM operations.mutation_commands WHERE status = 'readback_verified') AS commands,
         (SELECT count(*)::int FROM operations.mutation_receipts) AS receipts,
         (SELECT count(*)::int FROM operations.mutation_readbacks WHERE ok) AS readbacks,
         (SELECT count(*)::int FROM operations.external_confirmations) AS confirmations`,
    )).rows).toEqual([{ commands: 1, receipts: 1, readbacks: 1, confirmations: 1 }]);
    const chartLifecycles = (await owner.query<{
      task_id: string;
      status: string;
      maker_succeeded: boolean;
      checker_succeeded: boolean;
      accepted: boolean;
      has_command: boolean;
    }>(
      `SELECT task.task_id, task.status,
         EXISTS (
           SELECT 1 FROM operations.agent_runs run
           WHERE run.household_id = task.household_id
             AND run.task_id = task.task_id
             AND run.role = 'chart-maker'
             AND run.status = 'succeeded'
         ) AS maker_succeeded,
         EXISTS (
           SELECT 1 FROM operations.agent_runs run
           WHERE run.household_id = task.household_id
             AND run.task_id = task.task_id
             AND run.role = 'chart-checker'
             AND run.status = 'succeeded'
         ) AS checker_succeeded,
         EXISTS (
           SELECT 1 FROM operations.checker_verdicts verdict
           WHERE verdict.household_id = task.household_id
             AND verdict.task_id = task.task_id
             AND verdict.verdict = 'accepted'
         ) AS accepted,
         EXISTS (
           SELECT 1 FROM operations.mutation_commands command
           WHERE command.household_id = task.household_id
             AND command.task_id = task.task_id
         ) AS has_command
       FROM operations.verification_tasks task
       WHERE task.input_schema_name = 'chart-work-request'
       ORDER BY task.created_at`,
    )).rows;
    expect(chartLifecycles.map(({
      status,
      maker_succeeded,
      checker_succeeded,
      accepted,
      has_command,
    }) => ({ status, maker_succeeded, checker_succeeded, accepted, has_command }))).toEqual([
      {
        status: 'verified',
        maker_succeeded: true,
        checker_succeeded: true,
        accepted: true,
        has_command: true,
      },
      {
        status: 'verified',
        maker_succeeded: true,
        checker_succeeded: true,
        accepted: true,
        has_command: false,
      },
    ]);
    const persistedTransitions = (await owner.query<{ statuses: string[] }>(
      `SELECT array_agg(transition.to_status ORDER BY transition.sequence) AS statuses
       FROM operations.task_transitions transition
       JOIN operations.mutation_commands command
         ON command.household_id = transition.household_id
        AND command.task_id = transition.task_id
       WHERE command.command_type = 'apply_chart_of_accounts_change'`,
    )).rows[0]?.statuses ?? [];
    expect(persistedTransitions).toEqual(expect.arrayContaining([
      'maker_validated',
      'checker_validated',
      'execution_pending',
      'committed',
      'readback_verified',
      'verified',
    ]));
  }, 180_000);

  it('retains transaction fields when a missing category is corrected to existing Dining', async () => {
    const scenario = existingCategoryCorrectionScenario;
    context = await createPostgresTestContext('live_existing_category_correction');
    owner = new Pool({ connectionString: context.migratorUrl, max: 1 });
    await seedAccountingState(owner);
    await seedExistingCategoryCorrectionState(owner);
    server = await startMastraDevServer({
      env: databaseEnvironment(context),
      modelResponder: existingCategoryCorrectionResponder,
      rejectOutput: [
        /Peer dependency version mismatch detected/,
        /ERR_MODULE_NOT_FOUND/,
      ],
    });

    const started = await sendMessage(`add a transaction to ${scenario.paymentAccountName}`, 1);
    expect(started.body).toMatch(/amount/i);

    const unresolved = await sendMessage(
      `${scenario.amount} ${scenario.currency}, ${scenario.relativeDate}, ${scenario.unresolvedCategoryName}`,
      2,
    );
    expect(unresolved.body).toContain(`I don’t have a "${scenario.unresolvedCategoryName}" category yet.`);
    expect(unresolved.body).toContain(scenario.categoryName);
    expect(unresolved.body).toMatch(/add a new category/i);

    const corrected = await sendMessage(scenario.categoryName.toLowerCase(), 3);
    const correctionSynthesisPrompt = server.modelRequests()
      .map((request) => latestUserText(request.body))
      .filter((prompt) => prompt.includes('Safe checked context:'))
      .at(-1) ?? '';
    expect({
      proposalFacts: correctionSynthesisPrompt.includes('proposalFacts'),
      amount: correctionSynthesisPrompt.includes(`${scenario.currency} ${scenario.amount}`),
      paymentAccount: correctionSynthesisPrompt.includes(scenario.paymentAccountName),
      category: correctionSynthesisPrompt.includes(scenario.categoryName),
      date: correctionSynthesisPrompt.includes(scenario.expectedDate),
    }).toEqual({
      proposalFacts: true,
      amount: true,
      paymentAccount: true,
      category: true,
      date: true,
    });
    expect(corrected.body).toContain(`${scenario.currency} ${scenario.amount}`);
    expect(corrected.body).toContain(scenario.paymentAccountName);
    expect(corrected.body).toContain(scenario.categoryName);
    expect(corrected.body).toMatch(new RegExp(`${scenario.relativeDate}|${scenario.expectedDate}`, 'i'));
    expect(corrected.body).toMatch(/recorded|completed/i);
    expect(corrected.body).not.toMatch(/proceed\?|confirm/i);

    const replayedConfirmation = await sendMessage('YES', 4);
    expect(replayedConfirmation.body).not.toMatch(/recorded|completed|succeeded/i);
    expectNoImplementationDetails(replayedConfirmation.body);

    const queried = await sendMessage('list my transactions', 5);
    expect(queried.body).toContain(scenario.categoryName);
    expect(queried.body).toContain(scenario.amount);
    expect(queried.body).toContain(scenario.currency);
    expect(queried.body).toContain(scenario.expectedDate);
    expectNoImplementationDetails(queried.body);

    expect((await owner.query<{
      occurred_on: string;
      transaction_currency: string;
      description: string;
    }>(
      `SELECT occurred_on::text, transaction_currency, description
       FROM accounting.journals
       WHERE household_id = (SELECT id FROM operations.households WHERE household_id = $1)`,
      [ids.householdId],
    )).rows).toEqual([{
      occurred_on: scenario.expectedDate,
      transaction_currency: scenario.currency,
      description: 'Record the requested transaction.',
    }]);
    expect((await owner.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM accounting.postings
       WHERE household_id = (SELECT id FROM operations.households WHERE household_id = $1)`,
      [ids.householdId],
    )).rows).toEqual([{ count: 2 }]);
    expect((await owner.query<{
      commands: number;
      receipts: number;
      readbacks: number;
      confirmations: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM operations.mutation_commands WHERE status = 'readback_verified') AS commands,
         (SELECT count(*)::int FROM operations.mutation_receipts) AS receipts,
         (SELECT count(*)::int FROM operations.mutation_readbacks WHERE ok) AS readbacks,
         (SELECT count(*)::int FROM operations.external_confirmations) AS confirmations`,
    )).rows).toEqual([{ commands: 1, receipts: 1, readbacks: 1, confirmations: 0 }]);
  }, 180_000);

  it('times out a slow inbound turn without a hidden commit and accepts the next turn', async () => {
    context = await createPostgresTestContext('live_inbound_timeout_recovery');
    owner = new Pool({ connectionString: context.migratorUrl, max: 1 });
    server = await startMastraDevServer({
      env: {
        ...databaseEnvironment(context),
        ORCHESTRATOR_TURN_TIMEOUT_MS: '1000',
      },
      modelResponder: timeoutRecoveryResponder(),
      rejectOutput: [
        /Peer dependency version mismatch detected/,
        /ERR_MODULE_NOT_FOUND/,
      ],
    });

    const startedAt = Date.now();
    const timedOut = await postMessage('take too long before doing anything', 1);
    const elapsedMs = Date.now() - startedAt;
    expect(timedOut.status).toBe(504);
    expect(await timedOut.json()).toEqual({
      error: 'orchestrator_timed_out',
      retryable: true,
    });
    expect(elapsedMs).toBeGreaterThanOrEqual(900);
    expect(elapsedMs).toBeLessThan(2_500);

    const recovered = await sendMessage('hello after the timeout', 2);
    expect(recovered.body).toBe('The service recovered after the timed-out turn.');
    expect((await owner.query<{ commands: number; journals: number }>(
      `SELECT
         (SELECT count(*)::int FROM operations.mutation_commands) AS commands,
         (SELECT count(*)::int FROM accounting.journals) AS journals`,
    )).rows).toEqual([{ commands: 0, journals: 0 }]);
  }, 180_000);
});

const incompleteTransactionResponder: OpenAiCompatibleTestResponder = ({ body }) => {
  if (hasFunctionTool(body, 'delegateTeam') && !hasToolResult(body)) {
    return {
      finishReason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'delegate-team-live-accounting-1',
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
                  instruction: 'Record a transaction.',
                  known: {},
                },
              },
            }),
          },
        }],
      },
    };
  }
  return {
    finishReason: 'stop',
    message: { role: 'assistant', content: 'I checked the transaction request.' },
  };
};

const gasConversationResponder: OpenAiCompatibleTestResponder = ({ body }) => {
  const userText = latestUserText(body).toLowerCase();
  if (hasFunctionTool(body, 'delegateTeam') && !hasToolResult(body)) {
    const isQuery = userText.includes('list my transactions')
      || userText.includes('list all my transactions')
      || userText.includes('show the transactions');
    const request = isQuery
      ? queryRequest('categorized transactions')
      : userText.includes('add gas as a new category')
      ? chartRequest('Gas', 'IDR')
      : userText.includes('20k idr')
        ? transactionRequest({
            amount: '20000',
            currency: 'IDR',
            occurredOn: 'today',
            paymentAccountName: 'Bank ABC',
            categoryName: '  GAS  ',
          })
      : userText.includes('50k idr')
        ? transactionRequest({
            amount: '50000',
            currency: 'IDR',
            occurredOn: 'today',
            paymentAccountName: 'Bank ABC',
            categoryName: 'gas',
          })
        : transactionRequest({});
    return {
      finishReason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `delegate-team-gas-${userText.includes('50k idr') ? 'details' : userText.includes('add gas') ? 'category' : 'start'}`,
          type: 'function',
          function: {
            name: 'delegateTeam',
            arguments: JSON.stringify({ team: isQuery ? 'query' : 'accounting', request }),
          },
        }],
      },
    };
  }
  const checkedContext = latestToolResultText(body);
  if (checkedContext.includes('Gas')
    && checkedContext.includes('50000')
    && checkedContext.includes('20000')) {
    return {
      finishReason: 'stop',
      message: {
        role: 'assistant',
        content: 'You have IDR 50000 and IDR 20000 Gas transactions dated 2026-07-20 from Bank ABC.',
      },
    };
  }
  if (checkedContext.includes('Gas') && checkedContext.includes('50000')) {
    return {
      finishReason: 'stop',
      message: {
        role: 'assistant',
        content: 'You have an IDR 50000 Gas transaction dated 2026-07-20 from Bank ABC.',
      },
    };
  }
  const synthesisContext = latestUserText(body);
  if (synthesisContext.includes('Safe checked context:')
    && synthesisContext.includes('IDR 20000')
    && synthesisContext.includes('Bank ABC')
    && synthesisContext.includes('2026-07-20')
    && synthesisContext.includes('GAS')) {
    return {
      finishReason: 'stop',
      message: {
        role: 'assistant',
        content: 'I recorded IDR 20000 from Bank ABC on 2026-07-20 under Gas.',
      },
    };
  }
  if (synthesisContext.includes('Safe checked context:')
    && synthesisContext.includes('IDR 50000')
    && synthesisContext.includes('Bank ABC')
    && synthesisContext.includes('2026-07-20')
    && synthesisContext.includes('Gas')) {
    return {
      finishReason: 'stop',
      message: {
        role: 'assistant',
        content: 'I recorded IDR 50000 from Bank ABC on 2026-07-20 under Gas.',
      },
    };
  }
  if (!hasFunctionTool(body, 'delegateTeam')) {
    return {
      finishReason: 'stop',
      message: {
        role: 'assistant',
        content: 'I completed the checked accounting request.',
      },
    };
  }
  return {
    finishReason: 'stop',
    message: { role: 'assistant', content: 'I checked the accounting request.' },
  };
};

const foodsCombinedContinuationResponder: OpenAiCompatibleTestResponder = ({ body }) => {
  const userText = latestUserText(body).toLowerCase();
  const checkedContext = latestToolResultText(body);
  if (hasFunctionTool(body, 'delegateTeam')
    && userText.includes('add foods as a new category')
    && checkedContext.toLowerCase().includes('foods')
    && checkedContext.toLowerCase().includes('category')) {
    return {
      finishReason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'delegate-team-foods-category',
          type: 'function',
          function: {
            name: 'delegateTeam',
            arguments: JSON.stringify({
              team: 'accounting',
              request: chartRequest('Foods', 'IDR'),
            }),
          },
        }],
      },
    };
  }
  if (hasFunctionTool(body, 'delegateTeam') && !hasToolResult(body)) {
    const isQuery = userText.includes('transactions');
    const request = isQuery
      ? queryRequest('categorized transactions')
      : userText.includes('add foods as a new category')
        ? transactionRequest({ occurredOn: 'yesterday' })
        : transactionRequest({
            amount: '20000',
            currency: 'IDR',
            paymentAccountName: 'Bank ABC',
            categoryName: 'foods',
          });
    return {
      finishReason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `delegate-team-foods-${isQuery ? 'query' : userText.includes('add foods') ? 'category' : 'details'}`,
          type: 'function',
          function: {
            name: 'delegateTeam',
            arguments: JSON.stringify({ team: isQuery ? 'query' : 'accounting', request }),
          },
        }],
      },
    };
  }
  if (checkedContext.includes('Foods')
    && checkedContext.includes('20000')
    && checkedContext.includes('2026-07-19')) {
    return {
      finishReason: 'stop',
      message: {
        role: 'assistant',
        content: 'You have an IDR 20000 Foods transaction dated 2026-07-19 from Bank ABC.',
      },
    };
  }
  const synthesisContext = latestUserText(body);
  if (synthesisContext.includes('Safe checked context:')
    && synthesisContext.includes('IDR 20000')
    && synthesisContext.includes('Bank ABC')
    && synthesisContext.includes('2026-07-19')
    && synthesisContext.includes('Foods')) {
    return {
      finishReason: 'stop',
      message: {
        role: 'assistant',
        content: 'I recorded IDR 20000 from Bank ABC on 2026-07-19 under Foods.',
      },
    };
  }
  if (userText.includes('transactions')) {
    return {
      finishReason: 'stop',
      message: { role: 'assistant', content: "There aren't any transactions recorded at this time." },
    };
  }
  return {
    finishReason: 'stop',
    message: { role: 'assistant', content: 'I checked the accounting request.' },
  };
};

const accountConversationResponder: OpenAiCompatibleTestResponder = ({ body }) => {
  const userText = latestUserText(body).toLowerCase();
  if (hasFunctionTool(body, 'delegateTeam') && !hasToolResult(body)) {
    const isQuery = userText.includes('list my accounts')
      || userText.includes('show the household accounts');
    if (isQuery || userText.includes('wallet')) {
      const request = isQuery
        ? queryRequest('account list')
        : chartRequest('Wallet', 'IDR', 'asset', 'debit');
      return {
        finishReason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: `delegate-team-wallet-${isQuery ? 'query' : 'create'}`,
            type: 'function',
            function: {
              name: 'delegateTeam',
              arguments: JSON.stringify({ team: isQuery ? 'query' : 'accounting', request }),
            },
          }],
        },
      };
    }
    return {
      finishReason: 'stop',
      message: { role: 'assistant', content: 'There is no pending change to confirm.' },
    };
  }
  const checkedContext = latestToolResultText(body);
  if (checkedContext.includes('Wallet') && checkedContext.includes('already exists')) {
    return {
      finishReason: 'stop',
      message: {
        role: 'assistant',
        content: 'Wallet already exists as an IDR asset account with a normal debit balance. No new account was created.',
      },
    };
  }
  if (checkedContext.includes('Wallet') && checkedContext.includes('Bank ABC')) {
    return {
      finishReason: 'stop',
      message: {
        role: 'assistant',
        content: 'Your accounts are Bank ABC, Groceries, and Wallet.',
      },
    };
  }
  const synthesisContext = latestUserText(body);
  if (synthesisContext.includes('Safe checked context:') && synthesisContext.includes('Wallet')) {
    const awaiting = synthesisContext.includes('"effectState":"awaiting_confirmation"');
    return {
      finishReason: 'stop',
      message: {
        role: 'assistant',
        content: awaiting
          ? 'I’ll add Wallet as an IDR asset account with a normal debit balance. Would you like me to proceed?'
          : 'I added Wallet as an IDR asset account with a normal debit balance.',
      },
    };
  }
  return {
    finishReason: 'stop',
    message: { role: 'assistant', content: 'I completed the checked account request.' },
  };
};

const existingCategoryCorrectionScenario = {
  paymentAccountName: 'Test Wallet',
  categoryName: 'Dining',
  unresolvedCategoryName: 'food',
  amount: '50',
  currency: 'USD',
  relativeDate: 'yesterday',
  expectedDate: '2026-07-19',
} as const;

const existingCategoryCorrectionResponder: OpenAiCompatibleTestResponder = ({ body }) => {
  const scenario = existingCategoryCorrectionScenario;
  const userText = latestUserText(body).toLowerCase();
  if (hasFunctionTool(body, 'delegateTeam') && !hasToolResult(body)) {
    const isQuery = userText.includes('list my transactions');
    const isStart = userText.includes('add a transaction');
    const hasDetails = userText.includes(`${scenario.amount} ${scenario.currency.toLowerCase()}`);
    const isCategoryCorrection = userText.trim() === scenario.categoryName.toLowerCase();
    if (!isQuery && !isStart && !hasDetails && !isCategoryCorrection) {
      return {
        finishReason: 'stop',
        message: { role: 'assistant', content: 'There is no pending transaction to confirm.' },
      };
    }
    const request = isQuery
      ? queryRequest('categorized transactions')
      : isStart
        ? transactionRequest({ paymentAccountName: scenario.paymentAccountName })
        : hasDetails
          ? transactionRequest({
              amount: scenario.amount,
              currency: scenario.currency,
              occurredOn: scenario.relativeDate,
              categoryName: scenario.unresolvedCategoryName,
            })
          : transactionRequest({ categoryName: scenario.categoryName });
    return {
      finishReason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `delegate-team-existing-category-${isQuery ? 'query' : 'transaction'}`,
          type: 'function',
          function: {
            name: 'delegateTeam',
            arguments: JSON.stringify({ team: isQuery ? 'query' : 'accounting', request }),
          },
        }],
      },
    };
  }
  const checkedContext = latestToolResultText(body);
  if (userText.includes('list my transactions')
    && checkedContext.includes(scenario.categoryName)
    && checkedContext.includes(scenario.amount)
    && checkedContext.includes(scenario.expectedDate)) {
    return {
      finishReason: 'stop',
      message: {
        role: 'assistant',
        content: `You have a ${scenario.currency} ${scenario.amount} ${scenario.categoryName} transaction dated ${scenario.expectedDate} from ${scenario.paymentAccountName}.`,
      },
    };
  }
  const synthesisContext = latestUserText(body);
  const hasTransactionFacts = synthesisContext.includes(`${scenario.currency} ${scenario.amount}`)
    && synthesisContext.includes(scenario.paymentAccountName)
    && synthesisContext.includes(scenario.categoryName)
    && synthesisContext.includes(scenario.expectedDate);
  if (synthesisContext.includes('Safe checked context:') && hasTransactionFacts) {
    const awaiting = synthesisContext.includes('"effectState":"awaiting_confirmation"');
    return {
      finishReason: 'stop',
      message: {
        role: 'assistant',
        content: awaiting
          ? `I’ll record ${scenario.currency} ${scenario.amount} from ${scenario.paymentAccountName} on ${scenario.expectedDate} under ${scenario.categoryName}. Would you like me to proceed?`
          : `I recorded ${scenario.currency} ${scenario.amount} from ${scenario.paymentAccountName} on ${scenario.expectedDate} under ${scenario.categoryName}.`,
      },
    };
  }
  return {
    finishReason: 'stop',
    message: { role: 'assistant', content: 'I have a checked proposal ready. Would you like me to proceed?' },
  };
};

function timeoutRecoveryResponder(): OpenAiCompatibleTestResponder {
  let invocation = 0;
  return async () => {
    invocation += 1;
    if (invocation === 1) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return {
        finishReason: 'stop',
        message: { role: 'assistant', content: 'This response arrived too late.' },
      };
    }
    return {
      finishReason: 'stop',
      message: { role: 'assistant', content: 'The service recovered after the timed-out turn.' },
    };
  };
}

function transactionRequest(known: Record<string, string>) {
  return {
    schemaName: 'accounting-lead-request',
    schemaVersion: 1,
    intent: 'transaction_capture',
    request: {
      schemaName: 'transaction-capture-request-draft',
      schemaVersion: 1,
      instruction: 'Record the requested transaction.',
      known,
    },
  };
}

function queryRequest(coverage: string) {
  return {
    schemaName: 'query-lead-request-draft',
    schemaVersion: 1,
    businessQuestion: 'List the household transactions.',
    requiredCalculations: [],
    coverage: [coverage],
  };
}

function chartRequest(
  accountName: string,
  currency: string,
  accountingClass = 'expense',
  normalBalance = 'debit',
) {
  return {
    schemaName: 'accounting-lead-request',
    schemaVersion: 1,
    intent: 'chart_of_accounts',
    request: {
      schemaName: 'chart-work-request-draft',
      schemaVersion: 1,
      action: 'create_account',
      instruction: `Add ${accountName} as a new spending category.`,
      known: {
        accountName,
        accountingClass,
        normalBalance,
        nativeCurrency: currency,
      },
    },
  };
}

function hasFunctionTool(body: Record<string, unknown>, name: string): boolean {
  return functionToolNames(body).includes(name);
}

function functionToolNames(body: Record<string, unknown>): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.flatMap((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return [];
    const definition = candidate.function;
    return typeof definition === 'object'
      && definition !== null
      && !Array.isArray(definition)
      && typeof definition.name === 'string'
      ? [definition.name]
      : [];
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

function latestToolResultText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const candidate of [...messages].reverse()) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue;
    if (candidate.role !== 'tool') continue;
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

async function sendMessage(
  body: string,
  ordinal: number,
  conversationId: string = ids.conversationId,
): Promise<{ body: string; conversationId?: string }> {
  const response = await postMessage(body, ordinal, conversationId);
  expect(response.status).toBe(200);
  return await response.json() as { body: string; conversationId?: string };
}

async function postMessage(
  body: string,
  ordinal: number,
  conversationId: string = ids.conversationId,
): Promise<Response> {
  return fetch(`${server!.baseUrl}/plus-one/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(InboundChannelMessageSchemaV1.parse({
      schemaName: 'inbound-channel-message',
      schemaVersion: 1,
      conversationId,
      householdId: ids.householdId,
      channel: 'telegram',
      externalMessageId: `telegram:gas-live:${ordinal}`,
      receivedAt: '2026-07-20T08:00:00.000Z',
      speaker: { principalRef: 'telegram:user:42', displayName: 'Adam' },
      body,
      attachments: [],
      metadata: { destination: { chatId: 'telegram-chat-42' } },
    })),
  });
}

function expectTransactionQueryResult(body: string): void {
  expect(body).toContain('Gas');
  expect(body).toContain('50000');
  expect(body).toContain('IDR');
  expect(body).toContain('2026-07-20');
  expectNoImplementationDetails(body);
}

function expectAccountQueryResult(body: string): void {
  expect(body).toContain('Bank ABC');
  expect(body).toContain('Groceries');
  expect(body).toContain('Wallet');
  expectNoImplementationDetails(body);
}

function expectNoImplementationDetails(body: string): void {
  expect(body).not.toMatch(
    /safely|internal|schema|readback|native_currency|QueryResult|team status|maker|checker|reporting\./i,
  );
}

const ids = {
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  paymentAccountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  categoryAccountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
} as const;

async function seedAccountingState(pool: Pool): Promise<void> {
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

async function seedExistingCategoryCorrectionState(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO accounting.accounts
       (account_id, household_id, book_id, name, accounting_class, normal_balance, native_currency)
     VALUES
       ('account_01JNZQ4A9B8C7D6E5F4G3H2J3K',
        (SELECT id FROM operations.households WHERE household_id = $1),
        (SELECT id FROM accounting.books WHERE book_id = $2),
        'Test Wallet', 'asset', 'debit', 'USD'),
       ('account_01JNZQ4A9B8C7D6E5F4G3H2J4K',
        (SELECT id FROM operations.households WHERE household_id = $1),
        (SELECT id FROM accounting.books WHERE book_id = $2),
        'Dining', 'expense', 'debit', 'USD')`,
    [ids.householdId, ids.bookId],
  );
}

function databaseEnvironment(testContext: PostgresTestContext): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_MIGRATOR_URL: testContext.migratorUrl,
    DATABASE_ACCOUNTING_URL: testContext.roleUrls.accounting,
    DATABASE_PLANNING_URL: testContext.roleUrls.planning,
    DATABASE_OPERATIONS_URL: testContext.roleUrls.operations,
    DATABASE_QUERY_URL: testContext.roleUrls.query,
    DATABASE_MEMORY_URL: testContext.roleUrls.memory,
  };
}
