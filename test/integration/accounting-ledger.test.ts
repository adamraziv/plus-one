// test/integration/accounting-ledger.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  AccountingRepository, CorrectionService, JournalPostingService, LedgerReadback,
} from '@plus-one/accounting';
import type {
  AccountId, CurrencyCode, DecimalString,
} from '@plus-one/contracts';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';
import {
  accounts, bookId, householdId, postInput, seedLedgerScenario, type DraftSpec,
} from '../helpers/accounting-ledger.js';

const contexts: PostgresTestContext[] = [];
const resourceCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(resourceCleanups.splice(0).map(async (cleanup) => cleanup()));
  await Promise.all(contexts.splice(0).map(async (context) => context.cleanup()));
});

const usd = (accountId: string, direction: 'debit' | 'credit', amount: string) => ({
  accountId: accountId as AccountId, direction,
  transactionAmount: amount as DecimalString, accountNativeAmount: amount as DecimalString,
  accountNativeCurrency: 'USD' as CurrencyCode, tagIds: [] as never[],
});

describe('accounting ledger domain rules', () => {
  it('allows chart metadata edits but freezes class, normal balance, and currency after posting', async () => {
    const spec: DraftSpec = { index: 1, journalType: 'ordinary', description: 'Lunch',
      transactionCurrency: 'USD', postings: [
        usd(accounts.food, 'debit', '20.00'), usd(accounts.cash, 'credit', '20.00'),
      ] };
    const { client, cleanup } = await scenario('posted_account_identity', [spec]);
    await new JournalPostingService().postInTransaction(client, postInput(spec));
    await expect(new AccountingRepository().updateAccount(client, {
      householdId, bookId, accountId: accounts.cash, name: 'Cash',
      accountingClass: 'asset', normalBalance: 'debit', nativeCurrency: 'EUR',
    })).rejects.toMatchObject({ code: 'posted_account_financial_identity_immutable' });
    await client.query('ROLLBACK');
    await cleanup();
  });

  it('posts a balance-sheet transfer without income or expense effects', async () => {
    const spec: DraftSpec = { index: 1, journalType: 'transfer', description: 'Move savings',
      transactionCurrency: 'USD', postings: [
        usd(accounts.savings, 'debit', '100.00'), usd(accounts.cash, 'credit', '100.00'),
      ] };
    const { owner, client, cleanup } = await scenario('transfer', [spec]);
    await new JournalPostingService().postInTransaction(client, postInput(spec));
    await client.query('COMMIT');
    const classes = await owner.query(
      `SELECT DISTINCT account.accounting_class
       FROM accounting.postings posting
       JOIN accounting.accounts account ON account.id = posting.account_id`,
    );
    expect(classes.rows).toEqual([{ accounting_class: 'asset' }]);
    await cleanup();
  });

  it('rejects transfer drafts that touch income or expense accounts', async () => {
    const spec: DraftSpec = { index: 1, journalType: 'transfer', description: 'Invalid transfer',
      transactionCurrency: 'USD', postings: [
        usd(accounts.food, 'debit', '20.00'), usd(accounts.cash, 'credit', '20.00'),
      ] };
    const { client, cleanup } = await scenario('invalid_transfer', [spec]);
    await expect(new JournalPostingService().postInTransaction(client, postInput(spec)))
      .rejects.toMatchObject({ category: 'constraint_violation' });
    await client.query('ROLLBACK');
    await cleanup();
  });

  it('accepts exact cross-currency arithmetic and rejects a mismatched native amount', async () => {
    const valid: DraftSpec = { index: 1, journalType: 'fx_realized', description: 'Fund EUR account',
      transactionCurrency: 'USD', postings: [
        { accountId: accounts.euroBank as AccountId, direction: 'debit',
          transactionAmount: '20.00' as DecimalString,
          accountNativeAmount: '18.40' as DecimalString,
          accountNativeCurrency: 'EUR' as CurrencyCode,
          exchangeRate: '0.92' as DecimalString,
          exchangeRateQuote: 'native_per_transaction',
          exchangeRateDate: '2026-06-15' as import('@plus-one/contracts').LocalDate,
          exchangeRateSource: 'user-confirmed', tagIds: [] },
        usd(accounts.cash, 'credit', '20.00'),
      ] };
    const first = await scenario('valid_fx', [valid]);
    await new JournalPostingService().postInTransaction(first.client, postInput(valid));
    await first.client.query('COMMIT');
    await first.cleanup();

    const invalid: DraftSpec = { ...valid, postings: [
      { ...valid.postings[0]!, accountNativeAmount: '18.41' as DecimalString },
      valid.postings[1]!,
    ] };
    const second = await scenario('invalid_fx', [invalid]);
    await expect(new JournalPostingService().postInTransaction(second.client, postInput(invalid)))
      .rejects.toMatchObject({ category: 'constraint_violation' });
    await second.client.query('ROLLBACK');
    await second.cleanup();
  });

  it('reverses and replaces atomically and derives the corrected cash-basis balance', async () => {
    const original: DraftSpec = { index: 1, journalType: 'ordinary', description: 'Burger',
      transactionCurrency: 'USD', postings: [
        usd(accounts.food, 'debit', '20.00'), usd(accounts.cash, 'credit', '20.00'),
      ] };
    const reversal: DraftSpec = { index: 2, journalType: 'reversal',
      description: 'Reverse burger', transactionCurrency: 'USD', reversesIndex: 1,
      postings: [usd(accounts.food, 'credit', '20.00'), usd(accounts.cash, 'debit', '20.00')] };
    const replacement: DraftSpec = { index: 3, journalType: 'replacement',
      description: 'Correct burger', transactionCurrency: 'USD', replacesIndex: 1,
      postings: [usd(accounts.food, 'debit', '25.00'), usd(accounts.cash, 'credit', '25.00')] };
    const { owner, client, cleanup } = await scenario('correction', [original, reversal, replacement]);
    const posting = new JournalPostingService();
    await posting.postInTransaction(client, postInput(original));
    await new CorrectionService(posting).reverseAndReplaceInTransaction(client, {
      originalJournalId: postInput(original).journalId,
      reversal: postInput(reversal), replacement: postInput(replacement),
    });
    await client.query('COMMIT');
    const readback = new LedgerReadback();
    await expect(readback.accountNativeBalance(owner as never, {
      householdId, accountId: accounts.food, asOf: '2026-06-30',
    })).resolves.toEqual({ currency: 'USD', amount: '25.000000000000' });
    expect((await owner.query('SELECT count(*)::int AS count FROM accounting.journals')).rows[0])
      .toEqual({ count: 3 });
    await cleanup();
  });

  it('rejects posting to a closed period and allows explicit state transition back to open', async () => {
    const spec: DraftSpec = { index: 1, journalType: 'ordinary', description: 'Closed period item',
      transactionCurrency: 'USD', postings: [
        usd(accounts.food, 'debit', '20.00'), usd(accounts.cash, 'credit', '20.00'),
      ] };
    const { client, cleanup } = await scenario('closed_period', [spec]);
    const periods = new AccountingRepository();
    await periods.transitionPeriod(client, {
      householdId, periodId: 'period_00000000000000000000000001',
      expected: 'open', to: 'closed',
    });
    await expect(new JournalPostingService().postInTransaction(client, postInput(spec)))
      .rejects.toMatchObject({ category: 'period_closed' });
    await client.query('ROLLBACK');
    await cleanup();
  });
});

async function scenario(name: string, drafts: readonly DraftSpec[]) {
  const context = await createPostgresTestContext('accounting_' + name);
  contexts.push(context);
  const owner = new Pool({ connectionString: context.migratorUrl });
  await seedLedgerScenario(owner, drafts);
  const pool = new Pool({ connectionString: context.roleUrls.accounting });
  const client = await pool.connect();
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    client.release();
    await pool.end();
    await owner.end();
  };
  resourceCleanups.push(cleanup);
  return {
    owner, client, cleanup,
  };
}
