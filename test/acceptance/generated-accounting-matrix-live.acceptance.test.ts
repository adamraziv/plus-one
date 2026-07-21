import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { InboundChannelMessageSchemaV1 } from '@plus-one/contracts';
import { createPostgresTestContext, type PostgresTestContext } from '../helpers/postgres.js';
import {
  startProductionGatewayServer,
  type ProductionGatewayServerHandle,
} from '../helpers/production-gateway-server.js';
import type { OpenAiCompatibleTestResponder } from '../helpers/openai-compatible-test-server.js';

interface DirectTransactionScenario {
  id: string;
  seed: number;
  timezone: string;
  receivedAt: string;
  occurredOn: 'today' | 'yesterday' | string;
  expectedDate: string;
  amount: string;
  currency: string;
  paymentAccount: {
    name: string;
    accountingClass: 'asset' | 'liability';
    normalBalance: 'debit' | 'credit';
  };
  categoryAccount: {
    name: string;
    accountingClass: 'income' | 'expense';
    normalBalance: 'debit' | 'credit';
  };
  requestPaymentAccountName?: string;
  requestCategoryAccountName?: string;
  mutationMessage: string;
  queryMessage: string;
  querySession: 'immediate' | 'new';
}

type TransactionRequestScenario = Pick<
  DirectTransactionScenario,
  | 'amount'
  | 'currency'
  | 'occurredOn'
  | 'paymentAccount'
  | 'categoryAccount'
  | 'requestPaymentAccountName'
  | 'requestCategoryAccountName'
>;

interface InvalidTransactionScenario extends TransactionRequestScenario {
  id: string;
  seed: number;
  timezone: string;
  receivedAt: string;
  mutationMessage: string;
  queryMessage: string;
  invalidKind: 'date' | 'amount';
}

interface MultiTurnTransactionScenario extends DirectTransactionScenario {
  turns: readonly {
    message: string;
    known: Record<string, string>;
    expectedResponse?: RegExp;
    checkedTokens?: readonly string[];
  }[];
}

interface MissingCategoryPrerequisiteScenario extends DirectTransactionScenario {
  initialKnown: Record<string, string>;
  initialExpectedResponse: RegExp;
  prerequisiteMessage: string;
  prerequisiteKnown: Record<string, string>;
  confirmationMessage: string;
}

interface AccountCreationScenario {
  id: string;
  seed: number;
  timezone: string;
  receivedAt: string;
  currency: string;
  accountName: string;
  accountingClass: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  normalBalance: 'debit' | 'credit';
  mutationMessage: string;
  confirmationMessage: string;
  queryMessage: string;
  querySession: 'immediate' | 'new';
}

interface AccountDecisionScenario extends Omit<
  AccountCreationScenario,
  'confirmationMessage' | 'querySession'
> {
  decision: 'reject' | 'ambiguous-then-reject';
  decisionMessage: string;
}

type AccountFactsScenario = Pick<
  AccountCreationScenario,
  'accountName' | 'accountingClass' | 'normalBalance' | 'currency' | 'timezone'
>;

const directTransactionScenarios: readonly DirectTransactionScenario[] = [
  {
    id: 'TZ-SHANGHAI-AFTER-MIDNIGHT-YESTERDAY',
    seed: 20_260_721,
    timezone: 'Asia/Shanghai',
    receivedAt: '2026-07-20T16:30:00.000Z',
    occurredOn: 'yesterday',
    expectedDate: '2026-07-20',
    amount: '12345',
    currency: 'IDR',
    paymentAccount: { name: 'Bank ABC', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Groceries', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'could you log 12,345 idr from bank abc for groceries yesterday please',
    queryMessage: 'what household transactions do we have?',
    querySession: 'immediate',
  },
  {
    id: 'TZ-NEW-YORK-PRIOR-LOCAL-DAY-TODAY',
    seed: 20_260_719,
    timezone: 'America/New_York',
    receivedAt: '2026-07-20T03:30:00.000Z',
    occurredOn: 'today',
    expectedDate: '2026-07-19',
    amount: '42.75',
    currency: 'USD',
    paymentAccount: { name: 'Checking', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Dining', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'TODAY $42.75 dining from checking',
    queryMessage: 'show me the transaction history',
    querySession: 'new',
  },
  {
    id: 'FLOW-INCOME-DEPOSIT-ASSET',
    seed: 20_260_722,
    timezone: 'Asia/Singapore',
    receivedAt: '2026-07-22T02:15:00.000Z',
    occurredOn: '2026-07-18',
    expectedDate: '2026-07-18',
    amount: '2500.50',
    currency: 'USD',
    paymentAccount: { name: 'Everyday Checking', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Salary Income', accountingClass: 'income', normalBalance: 'credit' },
    mutationMessage: 'salary income 2,500.50 USD into Everyday Checking, dated 2026-07-18',
    queryMessage: 'list that income transaction',
    querySession: 'immediate',
  },
  {
    id: 'FLOW-EXPENSE-CHARGED-TO-LIABILITY',
    seed: 20_260_723,
    timezone: 'Australia/Sydney',
    receivedAt: '2026-07-23T11:45:00.000Z',
    occurredOn: 'today',
    expectedDate: '2026-07-23',
    amount: '88.90',
    currency: 'GBP',
    paymentAccount: { name: 'Visa Balance', accountingClass: 'liability', normalBalance: 'credit' },
    categoryAccount: { name: 'Fuel', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'charged GBP 88.90 of fuel to visa balance today',
    queryMessage: 'show the fuel charge',
    querySession: 'immediate',
  },
  {
    id: 'FLOW-INCOME-REDUCES-LIABILITY',
    seed: 20_260_724,
    timezone: 'Europe/Paris',
    receivedAt: '2026-07-24T12:00:00.000Z',
    occurredOn: '2026-07-21',
    expectedDate: '2026-07-21',
    amount: '15',
    currency: 'EUR',
    paymentAccount: { name: 'Carte Solde', accountingClass: 'liability', normalBalance: 'credit' },
    categoryAccount: { name: 'Cashback Income', accountingClass: 'income', normalBalance: 'credit' },
    mutationMessage: 'apply EUR 15 cashback income against Carte Solde for 2026-07-21',
    queryMessage: 'which cashback transaction was recorded?',
    querySession: 'new',
  },
  {
    id: 'DIRECT-CNY-MINIMUM-CENT-EXPLICIT-DATE',
    seed: 20_260_725,
    timezone: 'Asia/Shanghai',
    receivedAt: '2026-07-25T06:00:00.000Z',
    occurredOn: '2026-07-24',
    expectedDate: '2026-07-24',
    amount: '0.01',
    currency: 'CNY',
    paymentAccount: { name: 'Alipay Wallet', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Snacks', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: '2026-07-24 snacks CNY 0.01, Alipay Wallet',
    queryMessage: 'show the one-cent snack transaction',
    querySession: 'immediate',
  },
  {
    id: 'DIRECT-JPY-DAY-BEFORE-YESTERDAY',
    seed: 20_260_726,
    timezone: 'Asia/Tokyo',
    receivedAt: '2026-07-30T15:30:00.000Z',
    occurredOn: 'day before yesterday',
    expectedDate: '2026-07-29',
    amount: '900',
    currency: 'JPY',
    paymentAccount: { name: 'Cash Purse', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Rail Fare', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'rail fare 900 JPY from Cash Purse the day before yesterday',
    queryMessage: 'which rail fare did we record?',
    querySession: 'new',
  },
  {
    id: 'DIRECT-IDR-LARGE-FORMATTED-AMOUNT',
    seed: 20_260_727,
    timezone: 'Asia/Jakarta',
    receivedAt: '2026-07-27T05:00:00.000Z',
    occurredOn: 'today',
    expectedDate: '2026-07-27',
    amount: '999999999.99',
    currency: 'IDR',
    paymentAccount: { name: 'Primary Bank', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Equipment', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'IDR 999,999,999.99 equipment from Primary Bank today',
    queryMessage: 'list the large equipment transaction',
    querySession: 'immediate',
  },
  {
    id: 'DIRECT-GBP-NORMALIZED-ACCOUNT-REFERENCES',
    seed: 20_260_728,
    timezone: 'Europe/London',
    receivedAt: '2026-07-28T08:00:00.000Z',
    occurredOn: '2026-07-26',
    expectedDate: '2026-07-26',
    amount: '120.40',
    currency: 'GBP',
    paymentAccount: { name: 'Joint Current', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Household Bills', accountingClass: 'expense', normalBalance: 'debit' },
    requestPaymentAccountName: '  JOINT   CURRENT ',
    requestCategoryAccountName: ' household   bills ',
    mutationMessage: 'GBP 120.40 bills, 26 July, joint current',
    queryMessage: 'find the household bills payment',
    querySession: 'new',
  },
  {
    id: 'DIRECT-EUR-INCOME-MIXED-CASE-REFERENCES',
    seed: 20_260_729,
    timezone: 'Europe/Paris',
    receivedAt: '2026-07-29T08:00:00.000Z',
    occurredOn: 'yesterday',
    expectedDate: '2026-07-28',
    amount: '145.67',
    currency: 'EUR',
    paymentAccount: { name: 'Compte Courant', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Interest Income', accountingClass: 'income', normalBalance: 'credit' },
    requestPaymentAccountName: 'compte courant',
    requestCategoryAccountName: 'INTEREST INCOME',
    mutationMessage: 'interest income EUR 145.67 yesterday into compte courant',
    queryMessage: 'show yesterday’s interest income',
    querySession: 'immediate',
  },
  {
    id: 'DIRECT-USD-LARGE-INCOME-DEPOSIT',
    seed: 20_260_730,
    timezone: 'America/Denver',
    receivedAt: '2026-07-30T17:00:00.000Z',
    occurredOn: 'today',
    expectedDate: '2026-07-30',
    amount: '1000000.00',
    currency: 'USD',
    paymentAccount: { name: 'Business Checking', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Contract Revenue', accountingClass: 'income', normalBalance: 'credit' },
    mutationMessage: 'deposit USD 1,000,000.00 contract revenue into Business Checking today',
    queryMessage: 'list the million-dollar revenue transaction',
    querySession: 'new',
  },
  {
    id: 'DIRECT-IDR-TOMORROW-RELATIVE-DATE',
    seed: 20_260_731,
    timezone: 'Asia/Jakarta',
    receivedAt: '2026-07-29T08:00:00.000Z',
    occurredOn: 'tomorrow',
    expectedDate: '2026-07-30',
    amount: '25000',
    currency: 'IDR',
    paymentAccount: { name: 'Digital Wallet', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Mobile Data', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'schedule-record IDR 25k mobile data from Digital Wallet tomorrow',
    queryMessage: 'show the mobile data transaction',
    querySession: 'immediate',
  },
  {
    id: 'DIRECT-GBP-THE-DAY-BEFORE-YESTERDAY',
    seed: 20_260_732,
    timezone: 'Europe/London',
    receivedAt: '2026-07-30T12:00:00.000Z',
    occurredOn: 'the day before yesterday',
    expectedDate: '2026-07-28',
    amount: '8.25',
    currency: 'GBP',
    paymentAccount: { name: 'Pocket Cash', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Lunch', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'lunch £8.25, Pocket Cash, the day before yesterday',
    queryMessage: 'show that lunch transaction',
    querySession: 'new',
  },
  {
    id: 'DIRECT-CNY-EXPENSE-ON-LIABILITY',
    seed: 20_260_733,
    timezone: 'Asia/Shanghai',
    receivedAt: '2026-07-30T13:00:00.000Z',
    occurredOn: '2026-07-30',
    expectedDate: '2026-07-30',
    amount: '66.60',
    currency: 'CNY',
    paymentAccount: { name: 'Credit Line', accountingClass: 'liability', normalBalance: 'credit' },
    categoryAccount: { name: 'Gifts', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'CNY 66.60 gifts charged on Credit Line, 2026-07-30',
    queryMessage: 'find the gift charge',
    querySession: 'immediate',
  },
] as const;

const accountCreationScenarios: readonly AccountCreationScenario[] = [
  {
    id: 'ACCOUNT-LIABILITY-GBP-NATURAL-CONFIRMATION',
    seed: 30_260_701,
    timezone: 'Europe/London',
    receivedAt: '2026-07-25T09:00:00.000Z',
    currency: 'GBP',
    accountName: 'Travel Card',
    accountingClass: 'liability',
    normalBalance: 'credit',
    mutationMessage: 'please add Travel Card as a GBP liability with normal credit balance',
    confirmationMessage: 'yes, go ahead please',
    queryMessage: 'list our accounts',
    querySession: 'immediate',
  },
  {
    id: 'ACCOUNT-INCOME-USD-TERSE-CONFIRMATION',
    seed: 30_260_702,
    timezone: 'America/Chicago',
    receivedAt: '2026-07-25T15:00:00.000Z',
    currency: 'USD',
    accountName: 'Freelance Revenue',
    accountingClass: 'income',
    normalBalance: 'credit',
    mutationMessage: 'create USD income account: Freelance Revenue (credit)',
    confirmationMessage: 'yep',
    queryMessage: 'show household account names',
    querySession: 'new',
  },
  {
    id: 'ACCOUNT-EXPENSE-IDR-CAPITALIZED-CONFIRMATION',
    seed: 30_260_703,
    timezone: 'Asia/Jakarta',
    receivedAt: '2026-07-26T02:00:00.000Z',
    currency: 'IDR',
    accountName: 'Home Repairs',
    accountingClass: 'expense',
    normalBalance: 'debit',
    mutationMessage: 'ADD spending category Home Repairs, IDR, expense, debit',
    confirmationMessage: 'CONFIRM',
    queryMessage: 'what accounts exist now?',
    querySession: 'immediate',
  },
  {
    id: 'ACCOUNT-EQUITY-CNY-WHITESPACE',
    seed: 30_260_704,
    timezone: 'Asia/Shanghai',
    receivedAt: '2026-07-26T08:30:00.000Z',
    currency: 'CNY',
    accountName: 'Owner Capital',
    accountingClass: 'equity',
    normalBalance: 'credit',
    mutationMessage: '  create   Owner Capital   as CNY equity; normal credit  ',
    confirmationMessage: 'do it',
    queryMessage: 'list the chart of accounts',
    querySession: 'new',
  },
  {
    id: 'ACCOUNT-ASSET-JPY-OK-CONFIRMATION',
    seed: 30_260_705,
    timezone: 'Asia/Tokyo',
    receivedAt: '2026-07-27T00:30:00.000Z',
    currency: 'JPY',
    accountName: 'Emergency Cash',
    accountingClass: 'asset',
    normalBalance: 'debit',
    mutationMessage: 'make an asset named Emergency Cash in JPY, debit balance',
    confirmationMessage: 'ok',
    queryMessage: 'show me all household accounts',
    querySession: 'immediate',
  },
] as const;

const accountDecisionScenarios: readonly AccountDecisionScenario[] = [
  {
    id: 'ACCOUNT-REJECTION-PLEASE-CANCEL',
    seed: 30_260_706,
    timezone: 'Europe/London',
    receivedAt: '2026-07-27T10:00:00.000Z',
    currency: 'GBP',
    accountName: 'Holiday Fund',
    accountingClass: 'asset',
    normalBalance: 'debit',
    mutationMessage: 'create a GBP asset called Holiday Fund with debit balance',
    decision: 'reject',
    decisionMessage: 'please cancel',
    queryMessage: 'is Holiday Fund in our account list?',
  },
  {
    id: 'ACCOUNT-AMBIGUOUS-CORRECTION-DOES-NOT-COMMIT',
    seed: 30_260_707,
    timezone: 'America/Los_Angeles',
    receivedAt: '2026-07-27T18:00:00.000Z',
    currency: 'USD',
    accountName: 'Side Wallet',
    accountingClass: 'asset',
    normalBalance: 'debit',
    mutationMessage: 'add Side Wallet as a USD debit asset',
    decision: 'ambiguous-then-reject',
    decisionMessage: 'yes, but use GBP instead',
    queryMessage: 'does Side Wallet exist?',
  },
] as const;

const invalidTransactionScenarios: readonly InvalidTransactionScenario[] = [
  {
    id: 'TRANSACTION-INVALID-CALENDAR-DATE-NO-EFFECT',
    seed: 40_260_701,
    timezone: 'UTC',
    receivedAt: '2026-07-28T12:00:00.000Z',
    occurredOn: '2026-02-30',
    amount: '25',
    currency: 'USD',
    paymentAccount: { name: 'Checking', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Groceries', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'record USD 25 from Checking for Groceries on 2026-02-30',
    queryMessage: 'list all transactions after that request',
    invalidKind: 'date',
  },
  {
    id: 'TRANSACTION-ZERO-AMOUNT-NO-EFFECT',
    seed: 40_260_702,
    timezone: 'UTC',
    receivedAt: '2026-07-28T12:05:00.000Z',
    occurredOn: '2026-07-28',
    amount: '0',
    currency: 'USD',
    paymentAccount: { name: 'Checking', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Groceries', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'record zero USD from Checking for Groceries today',
    queryMessage: 'list all transactions after the zero request',
    invalidKind: 'amount',
  },
  {
    id: 'TRANSACTION-FRACTIONAL-JPY-NO-EFFECT',
    seed: 40_260_703,
    timezone: 'Asia/Tokyo',
    receivedAt: '2026-07-28T13:00:00.000Z',
    occurredOn: '2026-07-28',
    amount: '10.5',
    currency: 'JPY',
    paymentAccount: { name: 'Main Wallet', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Snacks', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'record JPY 10.5 from Main Wallet under Snacks today',
    queryMessage: 'list transactions after the fractional yen request',
    invalidKind: 'amount',
  },
  {
    id: 'TRANSACTION-NEGATIVE-AMOUNT-NO-EFFECT',
    seed: 40_260_704,
    timezone: 'UTC',
    receivedAt: '2026-07-28T13:05:00.000Z',
    occurredOn: '2026-07-28',
    amount: '-12',
    currency: 'USD',
    paymentAccount: { name: 'Checking', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Groceries', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'record negative USD 12 from Checking under Groceries',
    queryMessage: 'list transactions after the negative request',
    invalidKind: 'amount',
  },
] as const;

const multiTurnTransactionScenarios: readonly MultiTurnTransactionScenario[] = [
  {
    id: 'TRANSACTION-DETAILS-SPREAD-OVER-THREE-TURNS',
    seed: 50_260_701,
    timezone: 'UTC',
    receivedAt: '2026-07-30T09:00:00.000Z',
    occurredOn: 'yesterday',
    expectedDate: '2026-07-29',
    amount: '75',
    currency: 'USD',
    paymentAccount: { name: 'Checking', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Groceries', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'start a USD 75 transaction',
    queryMessage: 'show the completed split-detail transaction',
    querySession: 'immediate',
    turns: [
      {
        message: 'start a USD 75 transaction',
        known: { amount: '75', currency: 'USD' },
        expectedResponse: /account[\s\S]*date[\s\S]*category|account[\s\S]*category[\s\S]*date/i,
        checkedTokens: ['payment_account', 'occurred_on', 'category'],
      },
      {
        message: 'yesterday, paid from Checking',
        known: { occurredOn: 'yesterday', paymentAccountName: 'Checking' },
        expectedResponse: /category/i,
        checkedTokens: ['category'],
      },
      {
        message: 'put it under Groceries',
        known: { categoryName: 'Groceries' },
      },
    ],
  },
  {
    id: 'TRANSACTION-MISSING-CATEGORY-CORRECTED-WITH-CASE-WHITESPACE',
    seed: 50_260_702,
    timezone: 'Asia/Singapore',
    receivedAt: '2026-07-30T10:00:00.000Z',
    occurredOn: '2026-07-28',
    expectedDate: '2026-07-28',
    amount: '31.20',
    currency: 'USD',
    paymentAccount: { name: 'Daily Wallet', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Dining', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'USD 31.20 from Daily Wallet on 2026-07-28 for Takeout',
    queryMessage: 'find the corrected dining transaction',
    querySession: 'new',
    turns: [
      {
        message: 'USD 31.20 from Daily Wallet on 2026-07-28 for Takeout',
        known: {
          amount: '31.20',
          currency: 'USD',
          occurredOn: '2026-07-28',
          paymentAccountName: 'Daily Wallet',
          categoryName: 'Takeout',
        },
        expectedResponse: /Takeout.*Dining|Dining.*Takeout/i,
        checkedTokens: ['Takeout', 'Dining'],
      },
      {
        message: 'actually use   DINING  ',
        known: { categoryName: '  DINING  ' },
      },
    ],
  },
  {
    id: 'TRANSACTION-PAYMENT-ACCOUNT-CORRECTED-TO-LIABILITY',
    seed: 50_260_703,
    timezone: 'Europe/London',
    receivedAt: '2026-07-30T11:00:00.000Z',
    occurredOn: 'today',
    expectedDate: '2026-07-30',
    amount: '44.10',
    currency: 'GBP',
    paymentAccount: { name: 'Visa Balance', accountingClass: 'liability', normalBalance: 'credit' },
    categoryAccount: { name: 'Transport', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'GBP 44.10 today from Old Card for Transport',
    queryMessage: 'show the transport charge',
    querySession: 'immediate',
    turns: [
      {
        message: 'GBP 44.10 today from Old Card for Transport',
        known: {
          amount: '44.10',
          currency: 'GBP',
          occurredOn: 'today',
          paymentAccountName: 'Old Card',
          categoryName: 'Transport',
        },
        expectedResponse: /which account|pay from|payment account/i,
        checkedTokens: ['payment_account'],
      },
      {
        message: 'correction: charge Visa Balance',
        known: { paymentAccountName: 'Visa Balance' },
      },
    ],
  },
  {
    id: 'TRANSACTION-INVALID-TEXT-AMOUNT-CORRECTED',
    seed: 50_260_704,
    timezone: 'America/New_York',
    receivedAt: '2026-07-30T14:00:00.000Z',
    occurredOn: 'today',
    expectedDate: '2026-07-30',
    amount: '19.95',
    currency: 'USD',
    paymentAccount: { name: 'Checking', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Books', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'buying books today from Checking, amount was kind of twenty USD',
    queryMessage: 'list the corrected book transaction',
    querySession: 'new',
    turns: [
      {
        message: 'buying books today from Checking, amount was kind of twenty USD',
        known: {
          currency: 'USD',
          occurredOn: 'today',
          paymentAccountName: 'Checking',
          categoryName: 'Books',
        },
        expectedResponse: /what amount|provide.*amount/i,
        checkedTokens: ['amount'],
      },
      {
        message: 'exactly 19.95',
        known: { amount: '19.95' },
      },
    ],
  },
  {
    id: 'TRANSACTION-IMPOSSIBLE-DATE-CORRECTED',
    seed: 50_260_705,
    timezone: 'UTC',
    receivedAt: '2026-07-30T15:00:00.000Z',
    occurredOn: '2026-07-27',
    expectedDate: '2026-07-27',
    amount: '12',
    currency: 'EUR',
    paymentAccount: { name: 'Current Account', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Coffee', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'EUR 12 coffee from Current Account on 2026-02-30',
    queryMessage: 'show the date-corrected coffee transaction',
    querySession: 'immediate',
    turns: [
      {
        message: 'EUR 12 coffee from Current Account on 2026-02-30',
        known: {
          amount: '12',
          currency: 'EUR',
          occurredOn: '2026-02-30',
          paymentAccountName: 'Current Account',
          categoryName: 'Coffee',
        },
        expectedResponse: /valid date|what date|date.*transaction/i,
        checkedTokens: ['occurred_on'],
      },
      {
        message: 'the correct date is 2026-07-27',
        known: { occurredOn: '2026-07-27' },
      },
    ],
  },
] as const;

const missingCategoryPrerequisiteScenarios: readonly MissingCategoryPrerequisiteScenario[] = [
  {
    id: 'PREREQUISITE-AMOUNT-AND-MISSING-EXPENSE-CATEGORY',
    seed: 60_260_701,
    timezone: 'Europe/Paris',
    receivedAt: '2026-07-21T10:00:00.000Z',
    occurredOn: 'yesterday',
    expectedDate: '2026-07-20',
    amount: '17.50',
    currency: 'EUR',
    paymentAccount: { name: 'Joint Card', accountingClass: 'liability', normalBalance: 'credit' },
    categoryAccount: { name: 'Cafes', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'log a Cafes charge from Joint Card yesterday in EUR',
    queryMessage: 'show the new cafe charge',
    querySession: 'immediate',
    initialKnown: {
      currency: 'EUR',
      occurredOn: 'yesterday',
      paymentAccountName: 'Joint Card',
      categoryName: 'Cafes',
    },
    initialExpectedResponse: /amount/i,
    prerequisiteMessage: 'it was 17.50; please make Cafes a new category',
    prerequisiteKnown: { amount: '17.50' },
    confirmationMessage: 'sure, go ahead please',
  },
  {
    id: 'PREREQUISITE-CURRENCY-AND-MISSING-EXPENSE-CATEGORY',
    seed: 60_260_702,
    timezone: 'Asia/Tokyo',
    receivedAt: '2026-07-22T03:00:00.000Z',
    occurredOn: 'today',
    expectedDate: '2026-07-22',
    amount: '900',
    currency: 'JPY',
    paymentAccount: { name: 'Cash Purse', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Rail Snacks', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: '900 from Cash Purse today for Rail Snacks',
    queryMessage: 'find the rail snack transaction',
    querySession: 'new',
    initialKnown: {
      amount: '900',
      occurredOn: 'today',
      paymentAccountName: 'Cash Purse',
      categoryName: 'Rail Snacks',
    },
    initialExpectedResponse: /currency/i,
    prerequisiteMessage: 'JPY — add Rail Snacks as a new category',
    prerequisiteKnown: { currency: 'JPY' },
    confirmationMessage: 'confirm',
  },
  {
    id: 'PREREQUISITE-PAYMENT-ACCOUNT-AND-MISSING-EXPENSE-CATEGORY',
    seed: 60_260_703,
    timezone: 'America/New_York',
    receivedAt: '2026-07-23T15:00:00.000Z',
    occurredOn: '2026-07-22',
    expectedDate: '2026-07-22',
    amount: '25',
    currency: 'USD',
    paymentAccount: { name: 'Daily Wallet', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Pet Food', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'USD 25 on 2026-07-22 for Pet Food',
    queryMessage: 'list the pet food expense',
    querySession: 'immediate',
    initialKnown: {
      amount: '25',
      currency: 'USD',
      occurredOn: '2026-07-22',
      categoryName: 'Pet Food',
    },
    initialExpectedResponse: /account/i,
    prerequisiteMessage: 'Use Daily Wallet, and create Pet Food as the category',
    prerequisiteKnown: { paymentAccountName: 'Daily Wallet' },
    confirmationMessage: 'please proceed',
  },
  {
    id: 'PREREQUISITE-DATE-AND-MISSING-INCOME-CATEGORY',
    seed: 60_260_704,
    timezone: 'America/Chicago',
    receivedAt: '2026-07-24T15:00:00.000Z',
    occurredOn: 'yesterday',
    expectedDate: '2026-07-23',
    amount: '1200',
    currency: 'USD',
    paymentAccount: { name: 'Business Checking', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Consulting Income', accountingClass: 'income', normalBalance: 'credit' },
    mutationMessage: 'received USD 1200 into Business Checking as Consulting Income',
    queryMessage: 'show the consulting income deposit',
    querySession: 'new',
    initialKnown: {
      amount: '1200',
      currency: 'USD',
      paymentAccountName: 'Business Checking',
      categoryName: 'Consulting Income',
    },
    initialExpectedResponse: /date/i,
    prerequisiteMessage: 'yesterday, and add Consulting Income as a new income category',
    prerequisiteKnown: { occurredOn: 'yesterday' },
    confirmationMessage: 'yes, do it',
  },
] as const;

const lateProbeDirectTransactionScenarios: readonly DirectTransactionScenario[] = [
  {
    id: 'LATE-01-GBP-MONTH-BOUNDARY-YESTERDAY',
    seed: 60_260_801,
    timezone: 'Australia/Sydney',
    receivedAt: '2026-07-31T14:30:00.000Z',
    occurredOn: 'yesterday',
    expectedDate: '2026-07-31',
    amount: '73.45',
    currency: 'GBP',
    paymentAccount: { name: 'Everyday Offset', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Pet Care', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'yesterday’s pet care was GBP 73.45 from Everyday Offset',
    queryMessage: 'show the pet-care payment from the prior local day',
    querySession: 'new',
  },
  {
    id: 'LATE-02-CNY-UNICODE-NORMALIZED-INCOME',
    seed: 60_260_802,
    timezone: 'Asia/Singapore',
    receivedAt: '2026-07-31T08:00:00.000Z',
    occurredOn: '2026-07-30',
    expectedDate: '2026-07-30',
    amount: '6.08',
    currency: 'CNY',
    paymentAccount: { name: 'Café Wallet', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Rewards Income', accountingClass: 'income', normalBalance: 'credit' },
    requestPaymentAccountName: '  CAFÉ   WALLET ',
    requestCategoryAccountName: 'rewards   income',
    mutationMessage: 'CNY 6.08 rewards into café wallet on 30 July',
    queryMessage: 'find the rewards credit with the accented wallet name',
    querySession: 'immediate',
  },
  {
    id: 'LATE-03-JPY-ZERO-DECIMAL-TODAY',
    seed: 60_260_803,
    timezone: 'Asia/Seoul',
    receivedAt: '2026-07-31T09:00:00.000Z',
    occurredOn: 'today',
    expectedDate: '2026-07-31',
    amount: '1234',
    currency: 'JPY',
    paymentAccount: { name: 'Transit Cash', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Bus Fare', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'today: JPY 1,234 bus fare paid using Transit Cash',
    queryMessage: 'which yen-denominated bus transaction is recorded?',
    querySession: 'new',
  },
  {
    id: 'LATE-04-EUR-MINIMUM-EXPENSE-ON-LIABILITY',
    seed: 60_260_804,
    timezone: 'Europe/Zurich',
    receivedAt: '2026-07-31T15:00:00.000Z',
    occurredOn: '2026-07-29',
    expectedDate: '2026-07-29',
    amount: '0.01',
    currency: 'EUR',
    paymentAccount: { name: 'Travel Card', accountingClass: 'liability', normalBalance: 'credit' },
    categoryAccount: { name: 'Parking', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'charge EUR 0.01 parking to Travel Card, date 2026-07-29',
    queryMessage: 'show the minimum-value euro parking charge',
    querySession: 'immediate',
  },
] as const;

const lateProbeAccountCreationScenarios: readonly AccountCreationScenario[] = [
  {
    id: 'LATE-05-ACCOUNT-GBP-SURE-PROCEED-PLEASE',
    seed: 60_260_805,
    timezone: 'Australia/Perth',
    receivedAt: '2026-07-31T07:00:00.000Z',
    currency: 'GBP',
    accountName: "Kids' Savings",
    accountingClass: 'asset',
    normalBalance: 'debit',
    mutationMessage: "set up Kids' Savings as a GBP debit asset",
    confirmationMessage: 'sure, proceed please',
    queryMessage: "is Kids' Savings in the account list?",
    querySession: 'new',
  },
  {
    id: 'LATE-06-ACCOUNT-JPY-YES-PLEASE-DO-IT',
    seed: 60_260_806,
    timezone: 'Asia/Singapore',
    receivedAt: '2026-07-31T07:30:00.000Z',
    currency: 'JPY',
    accountName: 'Family Charge Card',
    accountingClass: 'liability',
    normalBalance: 'credit',
    mutationMessage: 'add Family Charge Card, JPY liability, normal credit',
    confirmationMessage: 'yes please do it',
    queryMessage: 'list the Family Charge Card account',
    querySession: 'immediate',
  },
] as const;

const lateProbeAccountDecisionScenarios: readonly AccountDecisionScenario[] = [
  {
    id: 'LATE-07-ACCOUNT-NATURAL-REJECTION-NO-THANKS',
    seed: 60_260_807,
    timezone: 'Europe/Amsterdam',
    receivedAt: '2026-07-31T10:00:00.000Z',
    currency: 'EUR',
    accountName: 'Weekend Cash',
    accountingClass: 'asset',
    normalBalance: 'debit',
    mutationMessage: 'create Weekend Cash as a EUR asset with debit balance',
    decision: 'reject',
    decisionMessage: "no thanks, don't create that",
    queryMessage: 'does Weekend Cash exist?',
  },
] as const;

const lateProbeInvalidTransactionScenarios: readonly InvalidTransactionScenario[] = [
  {
    id: 'LATE-08-USD-EXCESS-CURRENCY-SCALE-NO-EFFECT',
    seed: 60_260_808,
    timezone: 'America/Chicago',
    receivedAt: '2026-07-31T16:00:00.000Z',
    occurredOn: '2026-07-31',
    amount: '1.001',
    currency: 'USD',
    paymentAccount: { name: 'Checking', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Groceries', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'record USD 1.001 for Groceries from Checking today',
    queryMessage: 'did the over-precise dollar request create a transaction?',
    invalidKind: 'amount',
  },
] as const;

const lateProbeMultiTurnTransactionScenarios: readonly MultiTurnTransactionScenario[] = [
  {
    id: 'LATE-09-CURRENCY-SUPPLIED-AFTER-OTHER-DETAILS',
    seed: 60_260_809,
    timezone: 'America/Toronto',
    receivedAt: '2026-07-31T14:00:00.000Z',
    occurredOn: 'today',
    expectedDate: '2026-07-31',
    amount: '18.75',
    currency: 'USD',
    paymentAccount: { name: 'Daily Chequing', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Bakery', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: '18.75 today from Daily Chequing for Bakery',
    queryMessage: 'show the bakery transaction completed after the currency follow-up',
    querySession: 'immediate',
    turns: [
      {
        message: '18.75 today from Daily Chequing for Bakery',
        known: {
          amount: '18.75',
          occurredOn: 'today',
          paymentAccountName: 'Daily Chequing',
          categoryName: 'Bakery',
        },
        expectedResponse: /currency/i,
        checkedTokens: ['currency'],
      },
      {
        message: 'US dollars, USD',
        known: { currency: 'USD' },
      },
    ],
  },
  {
    id: 'LATE-10-INCOME-DATE-SUPPLIED-AS-TOMORROW',
    seed: 60_260_810,
    timezone: 'America/New_York',
    receivedAt: '2026-07-31T03:30:00.000Z',
    occurredOn: 'tomorrow',
    expectedDate: '2026-07-31',
    amount: '333.33',
    currency: 'USD',
    paymentAccount: { name: 'Brokerage Cash', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Dividend Income', accountingClass: 'income', normalBalance: 'credit' },
    mutationMessage: 'USD 333.33 dividend into Brokerage Cash; I will give the date next',
    queryMessage: 'show the dividend whose date arrived in the follow-up',
    querySession: 'new',
    turns: [
      {
        message: 'USD 333.33 dividend into Brokerage Cash; I will give the date next',
        known: {
          amount: '333.33',
          currency: 'USD',
          paymentAccountName: 'Brokerage Cash',
          categoryName: 'Dividend Income',
        },
        expectedResponse: /date/i,
        checkedTokens: ['occurred_on'],
      },
      {
        message: 'tomorrow',
        known: { occurredOn: 'tomorrow' },
      },
    ],
  },
] as const;

const finalLateDirectTransactionScenarios: readonly DirectTransactionScenario[] = [
  {
    id: 'FINAL-LATE-01-GBP-AUCKLAND-MONTH-BOUNDARY',
    seed: 80_260_701,
    timezone: 'Pacific/Auckland',
    receivedAt: '2026-08-01T00:15:00.000Z',
    occurredOn: 'yesterday',
    expectedDate: '2026-07-31',
    amount: '63.07',
    currency: 'GBP',
    paymentAccount: { name: 'Holiday Cash', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Museum Tickets', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'museum tickets were 63.07 GBP yesterday, paid with Holiday Cash',
    queryMessage: 'show the museum payment across the local month boundary',
    querySession: 'new',
  },
  {
    id: 'FINAL-LATE-02-CNY-UNICODE-INCOME',
    seed: 80_260_702,
    timezone: 'Asia/Shanghai',
    receivedAt: '2026-07-31T06:00:00.000Z',
    occurredOn: '2026-07-30',
    expectedDate: '2026-07-30',
    amount: '88.88',
    currency: 'CNY',
    paymentAccount: { name: '家庭钱包', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: '项目收入', accountingClass: 'income', normalBalance: 'credit' },
    mutationMessage: '2026-07-30 收到 CNY 88.88 到 家庭钱包，分类 项目收入',
    queryMessage: '列出项目收入交易',
    querySession: 'immediate',
  },
  {
    id: 'FINAL-LATE-03-JPY-LIABILITY-EXPENSE',
    seed: 80_260_703,
    timezone: 'Asia/Tokyo',
    receivedAt: '2026-07-31T08:00:00.000Z',
    occurredOn: 'today',
    expectedDate: '2026-07-31',
    amount: '999999',
    currency: 'JPY',
    paymentAccount: { name: 'Metro Card Balance', accountingClass: 'liability', normalBalance: 'credit' },
    categoryAccount: { name: 'Station Bento', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'charge today’s JPY 999,999 Station Bento to Metro Card Balance',
    queryMessage: 'which large bento charge is recorded?',
    querySession: 'new',
  },
  {
    id: 'FINAL-LATE-04-USD-TOMORROW-TEN-CENTS',
    seed: 80_260_704,
    timezone: 'America/Los_Angeles',
    receivedAt: '2026-07-30T18:00:00.000Z',
    occurredOn: 'tomorrow',
    expectedDate: '2026-07-31',
    amount: '0.10',
    currency: 'USD',
    paymentAccount: { name: 'Pocket Cash', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Donations', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'tomorrow put ten cents USD from Pocket Cash under Donations',
    queryMessage: 'show the ten-cent donation',
    querySession: 'immediate',
  },
] as const;

const finalLateAccountCreationScenarios: readonly AccountCreationScenario[] = [
  {
    id: 'FINAL-LATE-05-EUR-LIABILITY-ABSOLUTELY-PROCEED',
    seed: 80_260_705,
    timezone: 'Europe/Berlin',
    receivedAt: '2026-07-31T09:00:00.000Z',
    currency: 'EUR',
    accountName: 'Home Renovation Loan',
    accountingClass: 'liability',
    normalBalance: 'credit',
    mutationMessage: 'add Home Renovation Loan as a EUR liability with normal credit',
    confirmationMessage: 'absolutely, proceed',
    queryMessage: 'list Home Renovation Loan',
    querySession: 'new',
  },
  {
    id: 'FINAL-LATE-06-CNY-EQUITY-CERTAINLY',
    seed: 80_260_706,
    timezone: 'Asia/Hong_Kong',
    receivedAt: '2026-07-31T09:30:00.000Z',
    currency: 'CNY',
    accountName: 'Opening Equity Reserve',
    accountingClass: 'equity',
    normalBalance: 'credit',
    mutationMessage: 'create Opening Equity Reserve, CNY equity, credit normal balance',
    confirmationMessage: 'certainly',
    queryMessage: 'show Opening Equity Reserve in our accounts',
    querySession: 'immediate',
  },
] as const;

const finalLateAccountDecisionScenarios: readonly AccountDecisionScenario[] = [
  {
    id: 'FINAL-LATE-07-ACCOUNT-REJECTION-NEVER-MIND',
    seed: 80_260_707,
    timezone: 'UTC',
    receivedAt: '2026-07-31T10:00:00.000Z',
    currency: 'USD',
    accountName: 'Vacation Wallet',
    accountingClass: 'asset',
    normalBalance: 'debit',
    mutationMessage: 'make Vacation Wallet a USD asset account with debit balance',
    decision: 'reject',
    decisionMessage: 'never mind',
    queryMessage: 'is Vacation Wallet configured?',
  },
] as const;

const finalLateInvalidTransactionScenarios: readonly InvalidTransactionScenario[] = [
  {
    id: 'FINAL-LATE-08-EXPONENT-AMOUNT-NO-EFFECT',
    seed: 80_260_708,
    timezone: 'UTC',
    receivedAt: '2026-07-31T11:00:00.000Z',
    occurredOn: '2026-07-31',
    amount: '1e3',
    currency: 'USD',
    paymentAccount: { name: 'Checking', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Supplies', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'record USD 1e3 from Checking for Supplies today',
    queryMessage: 'did the exponent amount create anything?',
    invalidKind: 'amount',
  },
] as const;

const finalLateMultiTurnTransactionScenarios: readonly MultiTurnTransactionScenario[] = [
  {
    id: 'FINAL-LATE-09-CURRENCY-AND-RELATIVE-DATE-FOLLOW-UP',
    seed: 80_260_709,
    timezone: 'Europe/London',
    receivedAt: '2026-07-31T10:00:00.000Z',
    occurredOn: 'day before yesterday',
    expectedDate: '2026-07-29',
    amount: '64',
    currency: 'GBP',
    paymentAccount: { name: 'Current Account', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Books', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: '64 from Current Account for Books',
    queryMessage: 'show the book purchase completed from two follow-up fields',
    querySession: 'new',
    turns: [
      {
        message: '64 from Current Account for Books',
        known: {
          amount: '64',
          paymentAccountName: 'Current Account',
          categoryName: 'Books',
        },
        expectedResponse: /currency[\s\S]*date|date[\s\S]*currency/i,
        checkedTokens: ['currency', 'occurred_on'],
      },
      {
        message: 'GBP, and it was the day before yesterday',
        known: { currency: 'GBP', occurredOn: 'day before yesterday' },
      },
    ],
  },
] as const;

const finalLateMissingCategoryPrerequisiteScenarios: readonly MissingCategoryPrerequisiteScenario[] = [
  {
    id: 'FINAL-LATE-10-CURRENCY-AND-MISSING-INCOME-CATEGORY',
    seed: 80_260_710,
    timezone: 'Europe/Berlin',
    receivedAt: '2026-07-31T10:00:00.000Z',
    occurredOn: '2026-07-30',
    expectedDate: '2026-07-30',
    amount: '3200',
    currency: 'EUR',
    paymentAccount: { name: 'Business Wallet', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Workshop Revenue', accountingClass: 'income', normalBalance: 'credit' },
    mutationMessage: 'received 3200 into Business Wallet on 2026-07-30 as Workshop Revenue',
    queryMessage: 'show the workshop revenue deposit',
    querySession: 'immediate',
    initialKnown: {
      amount: '3200',
      occurredOn: '2026-07-30',
      paymentAccountName: 'Business Wallet',
      categoryName: 'Workshop Revenue',
    },
    initialExpectedResponse: /currency/i,
    prerequisiteMessage: 'Use EUR, and please add Workshop Revenue as a new income category.',
    prerequisiteKnown: { currency: 'EUR' },
    confirmationMessage: 'sounds good',
  },
] as const;

const postFixLateDirectTransactionScenarios: readonly DirectTransactionScenario[] = [
  {
    id: 'POSTFIX-LATE-01-EUR-KIRITIMATI-MONTH-BOUNDARY',
    seed: 90_260_701,
    timezone: 'Pacific/Kiritimati',
    receivedAt: '2026-08-31T11:15:00.000Z',
    occurredOn: 'yesterday',
    expectedDate: '2026-08-31',
    amount: '47.06',
    currency: 'EUR',
    paymentAccount: { name: 'Island Cash', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Ferry Snacks', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'yesterday’s ferry snacks were EUR 47.06 from Island Cash',
    queryMessage: 'show the ferry snack purchase across the local month boundary',
    querySession: 'new',
  },
  {
    id: 'POSTFIX-LATE-02-GBP-INCOME-REDUCES-LIABILITY',
    seed: 90_260_702,
    timezone: 'America/St_Johns',
    receivedAt: '2026-08-20T15:00:00.000Z',
    occurredOn: '2026-08-19',
    expectedDate: '2026-08-19',
    amount: '140.09',
    currency: 'GBP',
    paymentAccount: { name: 'Royalty Advance', accountingClass: 'liability', normalBalance: 'credit' },
    categoryAccount: { name: 'License Revenue', accountingClass: 'income', normalBalance: 'credit' },
    mutationMessage: 'apply GBP 140.09 of License Revenue to Royalty Advance on 2026-08-19',
    queryMessage: 'find the license revenue that reduced the advance',
    querySession: 'immediate',
  },
  {
    id: 'POSTFIX-LATE-03-CNY-MINIMUM-UNICODE',
    seed: 90_260_703,
    timezone: 'Asia/Singapore',
    receivedAt: '2026-08-15T04:00:00.000Z',
    occurredOn: 'today',
    expectedDate: '2026-08-15',
    amount: '0.01',
    currency: 'CNY',
    paymentAccount: { name: '零钱包', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: '茶点', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: '今天从零钱包记录 CNY 0.01，分类为茶点',
    queryMessage: '查找今天最小金额的茶点交易',
    querySession: 'new',
  },
] as const;

const postFixLateAccountCreationScenarios: readonly AccountCreationScenario[] = [
  {
    id: 'POSTFIX-LATE-04-JPY-INCOME-YEAH-GO-FOR-IT',
    seed: 90_260_704,
    timezone: 'Asia/Tokyo',
    receivedAt: '2026-08-21T03:00:00.000Z',
    currency: 'JPY',
    accountName: 'Referral Revenue',
    accountingClass: 'income',
    normalBalance: 'credit',
    mutationMessage: 'add Referral Revenue as a JPY income category with normal credit',
    confirmationMessage: 'yeah, go for it please',
    queryMessage: 'list Referral Revenue',
    querySession: 'new',
  },
  {
    id: 'POSTFIX-LATE-05-IDR-ASSET-PLEASE-GO-AHEAD',
    seed: 90_260_705,
    timezone: 'Asia/Jakarta',
    receivedAt: '2026-08-22T05:00:00.000Z',
    currency: 'IDR',
    accountName: 'Emergency Cash Box',
    accountingClass: 'asset',
    normalBalance: 'debit',
    mutationMessage: 'create Emergency Cash Box, an IDR asset with debit normal balance',
    confirmationMessage: 'please go ahead',
    queryMessage: 'show Emergency Cash Box in the account list',
    querySession: 'immediate',
  },
] as const;

const postFixLateAccountDecisionScenarios: readonly AccountDecisionScenario[] = [
  {
    id: 'POSTFIX-LATE-06-EUR-EQUITY-CORRECTION-THEN-CANCEL',
    seed: 90_260_706,
    timezone: 'UTC',
    receivedAt: '2026-08-23T10:00:00.000Z',
    currency: 'EUR',
    accountName: 'Founder Reserve',
    accountingClass: 'equity',
    normalBalance: 'credit',
    mutationMessage: 'make Founder Reserve a EUR equity account with a credit balance',
    decision: 'ambiguous-then-reject',
    decisionMessage: 'okay, but change the currency to GBP',
    queryMessage: 'does Founder Reserve exist?',
  },
] as const;

const postFixLateInvalidTransactionScenarios: readonly InvalidTransactionScenario[] = [
  {
    id: 'POSTFIX-LATE-07-INVALID-MONTH-NO-EFFECT',
    seed: 90_260_707,
    timezone: 'UTC',
    receivedAt: '2026-09-01T10:00:00.000Z',
    occurredOn: '2026-13-01',
    amount: '77',
    currency: 'JPY',
    paymentAccount: { name: 'Travel Wallet', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Lodging', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'record JPY 77 from Travel Wallet for Lodging on 2026-13-01',
    queryMessage: 'did the invalid-month request create a transaction?',
    invalidKind: 'date',
  },
] as const;

const postFixLateMultiTurnTransactionScenarios: readonly MultiTurnTransactionScenario[] = [
  {
    id: 'POSTFIX-LATE-08-INCOME-FIELDS-THREE-TURNS',
    seed: 90_260_708,
    timezone: 'Europe/Amsterdam',
    receivedAt: '2026-09-02T22:30:00.000Z',
    occurredOn: 'yesterday',
    expectedDate: '2026-09-02',
    amount: '450.75',
    currency: 'EUR',
    paymentAccount: { name: 'Tax Holding', accountingClass: 'liability', normalBalance: 'credit' },
    categoryAccount: { name: 'Course Sales', accountingClass: 'income', normalBalance: 'credit' },
    mutationMessage: '450.75 into Tax Holding for Course Sales',
    queryMessage: 'show the course sale completed over three messages',
    querySession: 'new',
    turns: [
      {
        message: '450.75 into Tax Holding for Course Sales',
        known: {
          amount: '450.75',
          paymentAccountName: 'Tax Holding',
          categoryName: 'Course Sales',
        },
        expectedResponse: /currency[\s\S]*date|date[\s\S]*currency/i,
        checkedTokens: ['currency', 'occurred_on'],
      },
      {
        message: 'use EUR',
        known: { currency: 'EUR' },
        expectedResponse: /date/i,
        checkedTokens: ['occurred_on'],
      },
      {
        message: 'yesterday',
        known: { occurredOn: 'yesterday' },
      },
    ],
  },
  {
    id: 'POSTFIX-LATE-09-CNY-ZERO-CORRECTED-MINIMUM',
    seed: 90_260_709,
    timezone: 'Asia/Shanghai',
    receivedAt: '2026-09-03T16:30:00.000Z',
    occurredOn: 'today',
    expectedDate: '2026-09-04',
    amount: '0.01',
    currency: 'CNY',
    paymentAccount: { name: 'Mobile Wallet', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Transit', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'CNY 0 today from Mobile Wallet for Transit',
    queryMessage: 'show the corrected minimum transit payment',
    querySession: 'immediate',
    turns: [
      {
        message: 'CNY 0 today from Mobile Wallet for Transit',
        known: {
          amount: '0',
          currency: 'CNY',
          occurredOn: 'today',
          paymentAccountName: 'Mobile Wallet',
          categoryName: 'Transit',
        },
        expectedResponse: /what amount|valid amount|positive amount/i,
        checkedTokens: ['amount'],
      },
      {
        message: 'correction: the exact amount is 0.01',
        known: { amount: '0.01' },
      },
    ],
  },
] as const;

const postFixLateMissingCategoryPrerequisiteScenarios: readonly MissingCategoryPrerequisiteScenario[] = [
  {
    id: 'POSTFIX-LATE-10-PAYMENT-AND-MISSING-INCOME-CATEGORY',
    seed: 90_260_710,
    timezone: 'Asia/Kathmandu',
    receivedAt: '2026-09-05T18:45:00.000Z',
    occurredOn: 'yesterday',
    expectedDate: '2026-09-05',
    amount: '725.50',
    currency: 'GBP',
    paymentAccount: { name: 'Main Current', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Freelance Bonus', accountingClass: 'income', normalBalance: 'credit' },
    mutationMessage: 'received GBP 725.50 yesterday as Freelance Bonus',
    queryMessage: 'find the freelance bonus in the new thread',
    querySession: 'new',
    initialKnown: {
      amount: '725.50',
      currency: 'GBP',
      occurredOn: 'yesterday',
      categoryName: 'Freelance Bonus',
    },
    initialExpectedResponse: /account/i,
    prerequisiteMessage: 'put it into Main Current, and set up Freelance Bonus as an income category',
    prerequisiteKnown: { paymentAccountName: 'Main Current' },
    confirmationMessage: 'yep, go ahead',
  },
] as const;

const finalPostPeriodDirectTransactionScenarios: readonly DirectTransactionScenario[] = [
  {
    id: 'FINAL2-LATE-01-USD-CHATHAM-MONTH-BOUNDARY',
    seed: 100_260_701,
    timezone: 'Pacific/Chatham',
    receivedAt: '2026-10-31T10:30:00.000Z',
    occurredOn: 'yesterday',
    expectedDate: '2026-10-31',
    amount: '58.40',
    currency: 'USD',
    paymentAccount: { name: 'Harbour Wallet', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Kayak Rental', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'USD 58.40 for Kayak Rental came from Harbour Wallet yesterday',
    queryMessage: 'show the kayak rental across Chatham midnight',
    querySession: 'new',
  },
  {
    id: 'FINAL2-LATE-02-IDR-LARGE-EXPLICIT-NOVEMBER',
    seed: 100_260_702,
    timezone: 'Asia/Makassar',
    receivedAt: '2026-11-15T03:00:00.000Z',
    occurredOn: '2026-11-14',
    expectedDate: '2026-11-14',
    amount: '88888888.88',
    currency: 'IDR',
    paymentAccount: { name: 'Dana Harian', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Home Repairs', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'catat IDR 88,888,888.88 dari Dana Harian untuk Home Repairs tanggal 2026-11-14',
    queryMessage: 'find the large November home repair',
    querySession: 'immediate',
  },
  {
    id: 'FINAL2-LATE-03-EUR-INCOME-TOMORROW-NEXT-MONTH',
    seed: 100_260_703,
    timezone: 'Africa/Nairobi',
    receivedAt: '2026-11-30T20:30:00.000Z',
    occurredOn: 'tomorrow',
    expectedDate: '2026-12-01',
    amount: '0.01',
    currency: 'EUR',
    paymentAccount: { name: 'Mobile Savings', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Interest Income', accountingClass: 'income', normalBalance: 'credit' },
    mutationMessage: 'tomorrow add EUR 0.01 of Interest Income into Mobile Savings',
    queryMessage: 'show the one-cent interest in December',
    querySession: 'new',
  },
] as const;

const finalPostPeriodAccountCreationScenarios: readonly AccountCreationScenario[] = [
  {
    id: 'FINAL2-LATE-04-GBP-LIABILITY-YUP-DO-SO',
    seed: 100_260_704,
    timezone: 'Europe/Dublin',
    receivedAt: '2026-11-20T10:00:00.000Z',
    currency: 'GBP',
    accountName: 'Studio Equipment Loan',
    accountingClass: 'liability',
    normalBalance: 'credit',
    mutationMessage: 'add Studio Equipment Loan as a GBP liability with normal credit',
    confirmationMessage: 'yup, do so please',
    queryMessage: 'show Studio Equipment Loan',
    querySession: 'immediate',
  },
  {
    id: 'FINAL2-LATE-05-CNY-EXPENSE-PLEASE-DO-IT',
    seed: 100_260_705,
    timezone: 'Asia/Shanghai',
    receivedAt: '2026-11-21T10:00:00.000Z',
    currency: 'CNY',
    accountName: 'Community Giving',
    accountingClass: 'expense',
    normalBalance: 'debit',
    mutationMessage: 'create Community Giving as a CNY spending category with debit balance',
    confirmationMessage: 'please do it',
    queryMessage: 'list Community Giving',
    querySession: 'new',
  },
] as const;

const finalPostPeriodAccountDecisionScenarios: readonly AccountDecisionScenario[] = [
  {
    id: 'FINAL2-LATE-06-JPY-ASSET-NOT-NOW',
    seed: 100_260_706,
    timezone: 'Asia/Tokyo',
    receivedAt: '2026-11-22T10:00:00.000Z',
    currency: 'JPY',
    accountName: 'Festival Cash',
    accountingClass: 'asset',
    normalBalance: 'debit',
    mutationMessage: 'set up Festival Cash as a JPY debit asset',
    decision: 'reject',
    decisionMessage: 'not now',
    queryMessage: 'is Festival Cash present?',
  },
] as const;

const finalPostPeriodInvalidTransactionScenarios: readonly InvalidTransactionScenario[] = [
  {
    id: 'FINAL2-LATE-07-EUR-EXCESS-PRECISION-NO-EFFECT',
    seed: 100_260_707,
    timezone: 'Europe/Paris',
    receivedAt: '2026-11-23T10:00:00.000Z',
    occurredOn: '2026-11-23',
    amount: '0.001',
    currency: 'EUR',
    paymentAccount: { name: 'Debit Card', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Parking', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'record EUR 0.001 from Debit Card for Parking on 2026-11-23',
    queryMessage: 'did the over-precise parking amount create anything?',
    invalidKind: 'amount',
  },
] as const;

const finalPostPeriodMultiTurnTransactionScenarios: readonly MultiTurnTransactionScenario[] = [
  {
    id: 'FINAL2-LATE-08-JPY-INCOME-DATE-AND-CURRENCY-FOLLOWUPS',
    seed: 100_260_708,
    timezone: 'Asia/Seoul',
    receivedAt: '2026-12-05T02:00:00.000Z',
    occurredOn: 'day before yesterday',
    expectedDate: '2026-12-03',
    amount: '120000',
    currency: 'JPY',
    paymentAccount: { name: 'Business Cash', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Speaking Income', accountingClass: 'income', normalBalance: 'credit' },
    mutationMessage: '120000 into Business Cash for Speaking Income',
    queryMessage: 'show the speaking income completed from follow-ups',
    querySession: 'immediate',
    turns: [
      {
        message: '120000 into Business Cash for Speaking Income',
        known: {
          amount: '120000',
          paymentAccountName: 'Business Cash',
          categoryName: 'Speaking Income',
        },
        expectedResponse: /currency[\s\S]*date|date[\s\S]*currency/i,
        checkedTokens: ['currency', 'occurred_on'],
      },
      {
        message: 'JPY',
        known: { currency: 'JPY' },
        expectedResponse: /date/i,
        checkedTokens: ['occurred_on'],
      },
      {
        message: 'the day before yesterday',
        known: { occurredOn: 'day before yesterday' },
      },
    ],
  },
  {
    id: 'FINAL2-LATE-09-USD-IMPOSSIBLE-NOVEMBER-DATE-CORRECTED',
    seed: 100_260_709,
    timezone: 'America/Phoenix',
    receivedAt: '2026-12-31T22:00:00.000Z',
    occurredOn: '2026-12-30',
    expectedDate: '2026-12-30',
    amount: '34.67',
    currency: 'USD',
    paymentAccount: { name: 'Joint Checking', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: 'Pharmacy', accountingClass: 'expense', normalBalance: 'debit' },
    mutationMessage: 'USD 34.67 from Joint Checking for Pharmacy on 2026-11-31',
    queryMessage: 'show the pharmacy purchase after correcting its date',
    querySession: 'new',
    turns: [
      {
        message: 'USD 34.67 from Joint Checking for Pharmacy on 2026-11-31',
        known: {
          amount: '34.67',
          currency: 'USD',
          occurredOn: '2026-11-31',
          paymentAccountName: 'Joint Checking',
          categoryName: 'Pharmacy',
        },
        expectedResponse: /valid date|what date|date.*transaction/i,
        checkedTokens: ['occurred_on'],
      },
      {
        message: 'correct date: 2026-12-30',
        known: { occurredOn: '2026-12-30' },
      },
    ],
  },
] as const;

const finalPostPeriodMissingCategoryPrerequisiteScenarios: readonly MissingCategoryPrerequisiteScenario[] = [
  {
    id: 'FINAL2-LATE-10-UNICODE-AMOUNT-AND-MISSING-INCOME-CATEGORY',
    seed: 100_260_710,
    timezone: 'Asia/Shanghai',
    receivedAt: '2026-12-31T16:30:00.000Z',
    occurredOn: 'yesterday',
    expectedDate: '2026-12-31',
    amount: '6600',
    currency: 'CNY',
    paymentAccount: { name: '主账户', accountingClass: 'asset', normalBalance: 'debit' },
    categoryAccount: { name: '年末奖金', accountingClass: 'income', normalBalance: 'credit' },
    mutationMessage: '昨天收到 CNY 到主账户，分类年末奖金，金额稍后提供',
    queryMessage: '在新会话中查找年末奖金',
    querySession: 'new',
    initialKnown: {
      currency: 'CNY',
      occurredOn: 'yesterday',
      paymentAccountName: '主账户',
      categoryName: '年末奖金',
    },
    initialExpectedResponse: /amount/i,
    prerequisiteMessage: '金额是 6600，并把年末奖金新增为收入分类',
    prerequisiteKnown: { amount: '6600' },
    confirmationMessage: 'sure, do it',
  },
] as const;

describe('generated accounting live matrix', () => {
  for (const scenario of directTransactionScenarios) {
    it(scenario.id, async () => {
      await runDirectTransactionScenario(scenario);
    }, 120_000);
  }
  for (const scenario of accountCreationScenarios) {
    it(scenario.id, async () => {
      await runAccountCreationScenario(scenario);
    }, 120_000);
  }
  for (const scenario of accountDecisionScenarios) {
    it(scenario.id, async () => {
      await runAccountDecisionScenario(scenario);
    }, 120_000);
  }
  for (const scenario of invalidTransactionScenarios) {
    it(scenario.id, async () => {
      await runInvalidTransactionScenario(scenario);
    }, 120_000);
  }
  for (const scenario of multiTurnTransactionScenarios) {
    it(scenario.id, async () => {
      await runMultiTurnTransactionScenario(scenario);
    }, 120_000);
  }
  for (const scenario of missingCategoryPrerequisiteScenarios) {
    it(scenario.id, async () => {
      await runMissingCategoryPrerequisiteScenario(scenario);
    }, 120_000);
  }
});

describe('late accounting live probes', () => {
  for (const scenario of lateProbeDirectTransactionScenarios) {
    it(scenario.id, async () => {
      await runDirectTransactionScenario(scenario);
    }, 120_000);
  }
  for (const scenario of lateProbeAccountCreationScenarios) {
    it(scenario.id, async () => {
      await runAccountCreationScenario(scenario);
    }, 120_000);
  }
  for (const scenario of lateProbeAccountDecisionScenarios) {
    it(scenario.id, async () => {
      await runAccountDecisionScenario(scenario);
    }, 120_000);
  }
  for (const scenario of lateProbeInvalidTransactionScenarios) {
    it(scenario.id, async () => {
      await runInvalidTransactionScenario(scenario);
    }, 120_000);
  }
  for (const scenario of lateProbeMultiTurnTransactionScenarios) {
    it(scenario.id, async () => {
      await runMultiTurnTransactionScenario(scenario);
    }, 120_000);
  }
});

describe('final unseen accounting live probes', () => {
  for (const scenario of finalLateDirectTransactionScenarios) {
    it(scenario.id, async () => {
      await runDirectTransactionScenario(scenario);
    }, 120_000);
  }
  for (const scenario of finalLateAccountCreationScenarios) {
    it(scenario.id, async () => {
      await runAccountCreationScenario(scenario);
    }, 120_000);
  }
  for (const scenario of finalLateAccountDecisionScenarios) {
    it(scenario.id, async () => {
      await runAccountDecisionScenario(scenario);
    }, 120_000);
  }
  for (const scenario of finalLateInvalidTransactionScenarios) {
    it(scenario.id, async () => {
      await runInvalidTransactionScenario(scenario);
    }, 120_000);
  }
  for (const scenario of finalLateMultiTurnTransactionScenarios) {
    it(scenario.id, async () => {
      await runMultiTurnTransactionScenario(scenario);
    }, 120_000);
  }
  for (const scenario of finalLateMissingCategoryPrerequisiteScenarios) {
    it(scenario.id, async () => {
      await runMissingCategoryPrerequisiteScenario(scenario);
    }, 120_000);
  }
});

describe('post-fix unseen accounting live probes', () => {
  for (const scenario of postFixLateDirectTransactionScenarios) {
    it(scenario.id, async () => {
      await runDirectTransactionScenario(scenario);
    }, 120_000);
  }
  for (const scenario of postFixLateAccountCreationScenarios) {
    it(scenario.id, async () => {
      await runAccountCreationScenario(scenario);
    }, 120_000);
  }
  for (const scenario of postFixLateAccountDecisionScenarios) {
    it(scenario.id, async () => {
      await runAccountDecisionScenario(scenario);
    }, 120_000);
  }
  for (const scenario of postFixLateInvalidTransactionScenarios) {
    it(scenario.id, async () => {
      await runInvalidTransactionScenario(scenario);
    }, 120_000);
  }
  for (const scenario of postFixLateMultiTurnTransactionScenarios) {
    it(scenario.id, async () => {
      await runMultiTurnTransactionScenario(scenario);
    }, 120_000);
  }
  for (const scenario of postFixLateMissingCategoryPrerequisiteScenarios) {
    it(scenario.id, async () => {
      await runMissingCategoryPrerequisiteScenario(scenario);
    }, 120_000);
  }
});

describe('final post-period unseen accounting live probes', () => {
  for (const scenario of finalPostPeriodDirectTransactionScenarios) {
    it(scenario.id, async () => {
      await runDirectTransactionScenario(scenario);
    }, 120_000);
  }
  for (const scenario of finalPostPeriodAccountCreationScenarios) {
    it(scenario.id, async () => {
      await runAccountCreationScenario(scenario);
    }, 120_000);
  }
  for (const scenario of finalPostPeriodAccountDecisionScenarios) {
    it(scenario.id, async () => {
      await runAccountDecisionScenario(scenario);
    }, 120_000);
  }
  for (const scenario of finalPostPeriodInvalidTransactionScenarios) {
    it(scenario.id, async () => {
      await runInvalidTransactionScenario(scenario);
    }, 120_000);
  }
  for (const scenario of finalPostPeriodMultiTurnTransactionScenarios) {
    it(scenario.id, async () => {
      await runMultiTurnTransactionScenario(scenario);
    }, 120_000);
  }
  for (const scenario of finalPostPeriodMissingCategoryPrerequisiteScenarios) {
    it(scenario.id, async () => {
      await runMissingCategoryPrerequisiteScenario(scenario);
    }, 120_000);
  }
});

async function runDirectTransactionScenario(scenario: DirectTransactionScenario): Promise<void> {
  const context = await createPostgresTestContext(`generated_${scenario.seed}`);
  const owner = new Pool({ connectionString: context.migratorUrl, max: 1 });
  let server: ProductionGatewayServerHandle | undefined;
  try {
    await seedScenario(owner, scenario);
    const before = await effectCounts(owner);
    server = await startProductionGatewayServer({
      env: databaseEnvironment(context),
      modelResponder: createScenarioResponder(scenario),
    });

    const mutation = await sendMessage(server, scenario, scenario.mutationMessage, 1);
    expect(mutation.status).toBe(200);
    const mutationResult = await mutation.json() as { body?: string };
    expectMaterialFacts(mutationResult.body, scenario, /recorded|completed/i);
    expectNoImplementationDetails(mutationResult.body);
    await expectTransactionState(owner, scenario, before);

    let queryConversationId = conversationId;
    if (scenario.querySession === 'new') {
      const reset = await sendMessage(server, scenario, '/new', 2);
      expect(reset.status).toBe(200);
      const resetResult = await reset.json() as { body?: string; conversationId?: string };
      expect(resetResult.body).toBe('Started a new thread.');
      expect(resetResult.conversationId).toMatch(/^conversation_/);
      if (resetResult.conversationId === undefined) throw new Error('Expected /new conversation id.');
      queryConversationId = resetResult.conversationId;
    }
    const query = await sendMessage(
      server,
      scenario,
      scenario.queryMessage,
      scenario.querySession === 'new' ? 3 : 2,
      queryConversationId,
    );
    expect(query.status).toBe(200);
    const queryResult = await query.json() as { body?: string };
    expectMaterialFacts(queryResult.body, scenario);
    expectNoImplementationDetails(queryResult.body);
    await expectTransactionState(owner, scenario, before);
  } finally {
    await server?.stop();
    await owner.end();
    await context.cleanup();
  }
}

async function runAccountCreationScenario(scenario: AccountCreationScenario): Promise<void> {
  const context = await createPostgresTestContext(`generated_${scenario.seed}`);
  const owner = new Pool({ connectionString: context.migratorUrl, max: 1 });
  let server: ProductionGatewayServerHandle | undefined;
  try {
    await seedAccountScenario(owner, scenario);
    const before = await accountEffectCounts(owner);
    server = await startProductionGatewayServer({
      env: databaseEnvironment(context),
      modelResponder: createAccountScenarioResponder(scenario),
    });

    const proposal = await sendMessage(server, scenario, scenario.mutationMessage, 1);
    expect(proposal.status).toBe(200);
    const proposalResult = await proposal.json() as { body?: string };
    expectAccountFacts(proposalResult.body, scenario);
    expect(proposalResult.body).toMatch(/proceed|confirm|go ahead/i);
    expect(proposalResult.body).not.toMatch(/created|added|saved|succeeded/i);
    expectNoImplementationDetails(proposalResult.body);
    expect(await accountEffectCounts(owner)).toEqual(before);

    const confirmation = await sendMessage(server, scenario, scenario.confirmationMessage, 2);
    expect(confirmation.status).toBe(200);
    const confirmationResult = await confirmation.json() as { body?: string };
    expectAccountFacts(confirmationResult.body, scenario);
    expect(confirmationResult.body).toMatch(/created|added/i);
    expectNoImplementationDetails(confirmationResult.body);
    await expectAccountState(owner, scenario, before);

    let queryConversationId = conversationId;
    if (scenario.querySession === 'new') {
      const reset = await sendMessage(server, scenario, '/new', 3);
      expect(reset.status).toBe(200);
      const resetResult = await reset.json() as { body?: string; conversationId?: string };
      expect(resetResult.body).toBe('Started a new thread.');
      if (resetResult.conversationId === undefined) throw new Error('Expected /new conversation id.');
      queryConversationId = resetResult.conversationId;
    }
    const query = await sendMessage(
      server,
      scenario,
      scenario.queryMessage,
      scenario.querySession === 'new' ? 4 : 3,
      queryConversationId,
    );
    expect(query.status).toBe(200);
    const queryResult = await query.json() as { body?: string };
    expect(queryResult.body).toContain(scenario.accountName);
    expectNoImplementationDetails(queryResult.body);
    await expectAccountState(owner, scenario, before);
  } finally {
    await server?.stop();
    await owner.end();
    await context.cleanup();
  }
}

async function runAccountDecisionScenario(scenario: AccountDecisionScenario): Promise<void> {
  const context = await createPostgresTestContext(`generated_${scenario.seed}`);
  const owner = new Pool({ connectionString: context.migratorUrl, max: 1 });
  let server: ProductionGatewayServerHandle | undefined;
  try {
    await seedAccountScenario(owner, scenario);
    const before = await accountEffectCounts(owner);
    server = await startProductionGatewayServer({
      env: databaseEnvironment(context),
      modelResponder: createAccountDecisionResponder(scenario),
    });

    const proposal = await sendMessage(server, scenario, scenario.mutationMessage, 1);
    expect(proposal.status).toBe(200);
    const proposalResult = await proposal.json() as { body?: string };
    expectAccountFacts(proposalResult.body, scenario);
    expect(proposalResult.body).toMatch(/proceed|confirm/i);
    expect(await accountEffectCounts(owner)).toEqual(before);

    const decision = await sendMessage(server, scenario, scenario.decisionMessage, 2);
    expect(decision.status).toBe(200);
    const decisionResult = await decision.json() as { body?: string };
    if (scenario.decision === 'reject') {
      expect(decisionResult.body).toMatch(/won.t|will not|cancel/i);
    } else {
      expectAccountFacts(decisionResult.body, scenario);
      expect(decisionResult.body).toMatch(/proceed|confirm/i);
      const rejection = await sendMessage(server, scenario, 'no, cancel it', 3);
      expect(rejection.status).toBe(200);
      const rejectionResult = await rejection.json() as { body?: string };
      expect(rejectionResult.body).toMatch(/won.t|will not|cancel/i);
    }
    expectNoImplementationDetails(decisionResult.body);
    expect(await accountEffectCounts(owner)).toEqual(before);

    const query = await sendMessage(
      server,
      scenario,
      scenario.queryMessage,
      scenario.decision === 'reject' ? 3 : 4,
    );
    expect(query.status).toBe(200);
    const queryResult = await query.json() as { body?: string };
    expect(queryResult.body).toContain(scenario.accountName);
    expect(queryResult.body).toMatch(/not (?:listed|present|found)|does not exist/i);
    expectNoImplementationDetails(queryResult.body);
    expect(await accountEffectCounts(owner)).toEqual(before);
  } finally {
    await server?.stop();
    await owner.end();
    await context.cleanup();
  }
}

async function runInvalidTransactionScenario(scenario: InvalidTransactionScenario): Promise<void> {
  const context = await createPostgresTestContext(`generated_${scenario.seed}`);
  const owner = new Pool({ connectionString: context.migratorUrl, max: 1 });
  let server: ProductionGatewayServerHandle | undefined;
  try {
    await seedScenario(owner, scenario);
    const before = await effectCounts(owner);
    server = await startProductionGatewayServer({
      env: databaseEnvironment(context),
      modelResponder: createInvalidTransactionResponder(scenario),
    });

    const mutation = await sendMessage(server, scenario, scenario.mutationMessage, 1);
    expect(mutation.status).toBe(200);
    const mutationResult = await mutation.json() as { body?: string };
    expect(mutationResult.body).toMatch(
      scenario.invalidKind === 'date'
        ? /valid date|what date|date.*invalid/i
        : /positive amount|valid amount|what amount|greater than zero/i,
    );
    expectNoImplementationDetails(mutationResult.body);
    expect(await effectCounts(owner)).toEqual(before);

    const query = await sendMessage(server, scenario, scenario.queryMessage, 2);
    expect(query.status).toBe(200);
    const queryResult = await query.json() as { body?: string };
    expect(queryResult.body).toMatch(/no (?:household )?transactions|none (?:were )?found|do not have any/i);
    expectNoImplementationDetails(queryResult.body);
    expect(await effectCounts(owner)).toEqual(before);
  } finally {
    await server?.stop();
    await owner.end();
    await context.cleanup();
  }
}

async function runMultiTurnTransactionScenario(
  scenario: MultiTurnTransactionScenario,
): Promise<void> {
  const context = await createPostgresTestContext(`generated_${scenario.seed}`);
  const owner = new Pool({ connectionString: context.migratorUrl, max: 1 });
  let server: ProductionGatewayServerHandle | undefined;
  try {
    await seedScenario(owner, scenario);
    const before = await effectCounts(owner);
    server = await startProductionGatewayServer({
      env: databaseEnvironment(context),
      modelResponder: createMultiTurnTransactionResponder(scenario),
    });

    for (const [index, turn] of scenario.turns.entries()) {
      const response = await sendMessage(server, scenario, turn.message, index + 1);
      expect(response.status).toBe(200);
      const result = await response.json() as { body?: string };
      if (index < scenario.turns.length - 1) {
        expect(result.body).toMatch(turn.expectedResponse!);
        expectNoImplementationDetails(result.body);
        expect(await effectCounts(owner)).toEqual(before);
      } else {
        expectMaterialFacts(result.body, scenario, /recorded|completed/i);
        expectNoImplementationDetails(result.body);
        await expectTransactionState(owner, scenario, before);
      }
    }

    let queryConversationId = conversationId;
    let ordinal = scenario.turns.length + 1;
    if (scenario.querySession === 'new') {
      const reset = await sendMessage(server, scenario, '/new', ordinal++);
      const resetResult = await reset.json() as { body?: string; conversationId?: string };
      expect(reset.status).toBe(200);
      expect(resetResult.body).toBe('Started a new thread.');
      if (resetResult.conversationId === undefined) throw new Error('Expected /new conversation id.');
      queryConversationId = resetResult.conversationId;
    }
    const query = await sendMessage(
      server,
      scenario,
      scenario.queryMessage,
      ordinal,
      queryConversationId,
    );
    expect(query.status).toBe(200);
    const queryResult = await query.json() as { body?: string };
    expectMaterialFacts(queryResult.body, scenario);
    expectNoImplementationDetails(queryResult.body);
    await expectTransactionState(owner, scenario, before);
  } finally {
    await server?.stop();
    await owner.end();
    await context.cleanup();
  }
}

async function runMissingCategoryPrerequisiteScenario(
  scenario: MissingCategoryPrerequisiteScenario,
): Promise<void> {
  const context = await createPostgresTestContext(`generated_${scenario.seed}`);
  const owner = new Pool({ connectionString: context.migratorUrl, max: 1 });
  let server: ProductionGatewayServerHandle | undefined;
  try {
    await seedScenario(owner, scenario, { includeTargetCategory: false });
    const before = await prerequisiteEffectCounts(owner);
    server = await startProductionGatewayServer({
      env: databaseEnvironment(context),
      modelResponder: createMissingCategoryPrerequisiteResponder(scenario),
    });

    const initial = await sendMessage(server, scenario, scenario.mutationMessage, 1);
    expect(initial.status).toBe(200);
    const initialResult = await initial.json() as { body?: string };
    expect(initialResult.body).toMatch(scenario.initialExpectedResponse);
    expect(initialResult.body).toContain(scenario.categoryAccount.name);
    if (scenario.categoryAccount.accountingClass === 'income') {
      expect(initialResult.body).not.toMatch(/spending categor/i);
    }
    expectNoImplementationDetails(initialResult.body);
    expect(await prerequisiteEffectCounts(owner)).toEqual(before);

    const proposal = await sendMessage(server, scenario, scenario.prerequisiteMessage, 2);
    expect(proposal.status).toBe(200);
    const proposalResult = await proposal.json() as { body?: string };
    expect(proposalResult.body).toContain(scenario.currency);
    expect(proposalResult.body).toContain(scenario.amount);
    expect(proposalResult.body).toContain(scenario.paymentAccount.name);
    expect(proposalResult.body).toContain(scenario.categoryAccount.name);
    expect(proposalResult.body).toContain(scenario.occurredOn);
    expect(proposalResult.body).toMatch(/proceed|confirm|go ahead/i);
    expect(proposalResult.body).not.toMatch(/created|recorded|completed|succeeded/i);
    expectNoImplementationDetails(proposalResult.body);
    expect(await prerequisiteEffectCounts(owner)).toEqual(before);

    const sequentialLoopRequests = server.modelRequests().filter(({ body }) =>
      latestUserText(body) === scenario.prerequisiteMessage
      && lastMessageRole(body) === 'tool'
      && hasFunctionTool(body, 'delegateTeam'));
    expect(sequentialLoopRequests.length).toBeGreaterThanOrEqual(1);

    const confirmation = await sendMessage(server, scenario, scenario.confirmationMessage, 3);
    expect(confirmation.status).toBe(200);
    const confirmationResult = await confirmation.json() as { body?: string };
    expectMaterialFacts(confirmationResult.body, scenario, /recorded|completed/i);
    expectNoImplementationDetails(confirmationResult.body);
    await expectPrerequisiteTransactionState(owner, scenario, before);

    let queryConversationId = conversationId;
    let ordinal = 4;
    if (scenario.querySession === 'new') {
      const reset = await sendMessage(server, scenario, '/new', ordinal++);
      expect(reset.status).toBe(200);
      const resetResult = await reset.json() as { body?: string; conversationId?: string };
      expect(resetResult.body).toBe('Started a new thread.');
      if (resetResult.conversationId === undefined) throw new Error('Expected /new conversation id.');
      queryConversationId = resetResult.conversationId;
    }
    const query = await sendMessage(server, scenario, scenario.queryMessage, ordinal, queryConversationId);
    expect(query.status).toBe(200);
    const queryResult = await query.json() as { body?: string };
    expectMaterialFacts(queryResult.body, scenario);
    expectNoImplementationDetails(queryResult.body);
    await expectPrerequisiteTransactionState(owner, scenario, before);
  } finally {
    await server?.stop();
    await owner.end();
    await context.cleanup();
  }
}

function createScenarioResponder(scenario: DirectTransactionScenario): OpenAiCompatibleTestResponder {
  return ({ body }) => {
    if (hasFunctionTool(body, 'submitResult')) return undefined;
    const userText = latestUserText(body);
    if (hasFunctionTool(body, 'delegateTeam') && lastMessageRole(body) === 'user') {
      const isQuery = userText === scenario.queryMessage;
      return {
        finishReason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: `delegate-${scenario.seed}-${isQuery ? 'query' : 'transaction'}`,
            type: 'function',
            function: {
              name: 'delegateTeam',
              arguments: JSON.stringify({
                team: isQuery ? 'query' : 'accounting',
                request: isQuery
                  ? queryRequest()
                  : transactionRequest(scenario),
              }),
            },
          }],
        },
      };
    }
    const safeContext = userText;
    if (safeContext.includes('Safe checked context:') && containsMaterialFacts(safeContext, scenario)) {
      return {
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: `I recorded ${scenario.currency} ${scenario.amount} from ${scenario.paymentAccount.name} on ${scenario.expectedDate} under ${scenario.categoryAccount.name}.`,
        },
      };
    }
    const checkedContext = latestToolResultText(body);
    if (containsMaterialFacts(checkedContext, scenario)) {
      return {
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: `The household has a ${scenario.currency} ${scenario.amount} transaction from ${scenario.paymentAccount.name} on ${scenario.expectedDate} under ${scenario.categoryAccount.name}.`,
        },
      };
    }
    return {
      finishReason: 'stop',
      message: { role: 'assistant', content: 'I could not verify the requested accounting facts.' },
    };
  };
}

function createAccountScenarioResponder(scenario: AccountCreationScenario): OpenAiCompatibleTestResponder {
  return ({ body }) => {
    if (hasFunctionTool(body, 'submitResult')) return undefined;
    const userText = latestUserText(body);
    if (hasFunctionTool(body, 'delegateTeam') && lastMessageRole(body) === 'user') {
      if (userText !== scenario.mutationMessage && userText !== scenario.queryMessage) {
        return {
          finishReason: 'stop',
          message: { role: 'assistant', content: 'There is no pending account change to confirm.' },
        };
      }
      const isQuery = userText === scenario.queryMessage;
      return {
        finishReason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: `delegate-${scenario.seed}-${isQuery ? 'query' : 'chart'}`,
            type: 'function',
            function: {
              name: 'delegateTeam',
              arguments: JSON.stringify({
                team: isQuery ? 'query' : 'accounting',
                request: isQuery ? accountQueryRequest() : chartRequest(scenario),
              }),
            },
          }],
        },
      };
    }
    if (userText.includes('Safe checked context:') && containsAccountFacts(userText, scenario)) {
      const awaiting = userText.includes('"effectState":"awaiting_confirmation"');
      return {
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: awaiting
            ? `I'll create ${scenario.accountName} as a ${scenario.currency} ${scenario.accountingClass} account with a normal ${scenario.normalBalance} balance. Would you like me to proceed?`
            : `I created ${scenario.accountName} as a ${scenario.currency} ${scenario.accountingClass} account with a normal ${scenario.normalBalance} balance.`,
        },
      };
    }
    const checkedContext = latestToolResultText(body);
    if (checkedContext.includes(scenario.accountName)) {
      return {
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: `${scenario.accountName} is listed in the household accounts.`,
        },
      };
    }
    return {
      finishReason: 'stop',
      message: { role: 'assistant', content: 'I could not verify the requested account facts.' },
    };
  };
}

function createAccountDecisionResponder(scenario: AccountDecisionScenario): OpenAiCompatibleTestResponder {
  return ({ body }) => {
    if (hasFunctionTool(body, 'submitResult')) return undefined;
    const userText = latestUserText(body);
    if (hasFunctionTool(body, 'delegateTeam') && lastMessageRole(body) === 'user') {
      if (userText === scenario.mutationMessage || userText === scenario.queryMessage) {
        const isQuery = userText === scenario.queryMessage;
        return {
          finishReason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: `delegate-${scenario.seed}-${isQuery ? 'query' : 'chart'}`,
              type: 'function',
              function: {
                name: 'delegateTeam',
                arguments: JSON.stringify({
                  team: isQuery ? 'query' : 'accounting',
                  request: isQuery ? accountQueryRequest() : chartRequest(scenario),
                }),
              },
            }],
          },
        };
      }
      return {
        finishReason: 'stop',
        message: { role: 'assistant', content: 'There is no new account request.' },
      };
    }
    if (userText.includes('Safe checked context:') && containsAccountFacts(userText, scenario)) {
      return {
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: `I'll create ${scenario.accountName} as a ${scenario.currency} ${scenario.accountingClass} account with a normal ${scenario.normalBalance} balance. Would you like me to proceed?`,
        },
      };
    }
    const checkedContext = latestToolResultText(body);
    if (userText === scenario.queryMessage && !checkedContext.includes(scenario.accountName)) {
      return {
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: `${scenario.accountName} is not listed in the household accounts.`,
        },
      };
    }
    return {
      finishReason: 'stop',
      message: { role: 'assistant', content: 'I could not verify the requested account facts.' },
    };
  };
}

function createInvalidTransactionResponder(
  scenario: InvalidTransactionScenario,
): OpenAiCompatibleTestResponder {
  return ({ body }) => {
    if (hasFunctionTool(body, 'submitResult')) return undefined;
    const userText = latestUserText(body);
    if (hasFunctionTool(body, 'delegateTeam') && lastMessageRole(body) === 'user') {
      const isQuery = userText === scenario.queryMessage;
      return {
        finishReason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: `delegate-${scenario.seed}-${isQuery ? 'query' : 'invalid-transaction'}`,
            type: 'function',
            function: {
              name: 'delegateTeam',
              arguments: JSON.stringify({
                team: isQuery ? 'query' : 'accounting',
                request: isQuery ? queryRequest() : transactionRequest(scenario),
              }),
            },
          }],
        },
      };
    }
    const checkedContext = latestToolResultText(body);
    if (userText === scenario.queryMessage && checkedContext.length > 0) {
      return {
        finishReason: 'stop',
        message: { role: 'assistant', content: 'No household transactions were found.' },
      };
    }
    const safeContext = `${userText} ${checkedContext}`.toLowerCase();
    if (scenario.invalidKind === 'date'
      && (safeContext.includes('date') || safeContext.includes('occurred_on'))) {
      return {
        finishReason: 'stop',
        message: { role: 'assistant', content: 'Please provide a valid transaction date.' },
      };
    }
    if (scenario.invalidKind === 'amount' && safeContext.includes('amount')) {
      return {
        finishReason: 'stop',
        message: { role: 'assistant', content: 'Please provide a valid positive amount greater than zero.' },
      };
    }
    return {
      finishReason: 'stop',
      message: { role: 'assistant', content: 'I could not verify this transaction request.' },
    };
  };
}

function createMultiTurnTransactionResponder(
  scenario: MultiTurnTransactionScenario,
): OpenAiCompatibleTestResponder {
  return ({ body }) => {
    if (hasFunctionTool(body, 'submitResult')) return undefined;
    const userText = latestUserText(body);
    if (hasFunctionTool(body, 'delegateTeam') && lastMessageRole(body) === 'user') {
      if (userText === scenario.queryMessage) {
        return delegateCompletion(`delegate-${scenario.seed}-query`, 'query', queryRequest());
      }
      const turn = scenario.turns.find((candidate) => candidate.message === userText);
      if (turn !== undefined) {
        return delegateCompletion(
          `delegate-${scenario.seed}-turn-${scenario.turns.indexOf(turn) + 1}`,
          'accounting',
          transactionDraftRequest(turn.known),
        );
      }
    }
    if (userText.includes('Safe checked context:') && containsMaterialFacts(userText, scenario)) {
      return {
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: `I recorded ${scenario.currency} ${scenario.amount} from ${scenario.paymentAccount.name} on ${scenario.expectedDate} under ${scenario.categoryAccount.name}.`,
        },
      };
    }
    const checkedContext = latestToolResultText(body);
    if (userText === scenario.queryMessage && containsMaterialFacts(checkedContext, scenario)) {
      return {
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: `The household has a ${scenario.currency} ${scenario.amount} transaction from ${scenario.paymentAccount.name} on ${scenario.expectedDate} under ${scenario.categoryAccount.name}.`,
        },
      };
    }
    const turn = scenario.turns.find((candidate) => candidate.message === userText);
    if (turn?.expectedResponse !== undefined
      && turn.checkedTokens?.every((token) => checkedContext.includes(token)) === true) {
      return {
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: clarificationText(turn.checkedTokens),
        },
      };
    }
    return {
      finishReason: 'stop',
      message: { role: 'assistant', content: 'I could not verify the transaction details.' },
    };
  };
}

function createMissingCategoryPrerequisiteResponder(
  scenario: MissingCategoryPrerequisiteScenario,
): OpenAiCompatibleTestResponder {
  return ({ body }) => {
    if (hasFunctionTool(body, 'submitResult')) return undefined;
    const userText = latestUserText(body);
    const checkedContext = latestToolResultText(body);
    if (hasFunctionTool(body, 'delegateTeam') && lastMessageRole(body) === 'user') {
      if (userText === scenario.queryMessage) {
        return delegateCompletion(`delegate-${scenario.seed}-query`, 'query', queryRequest());
      }
      if (userText === scenario.mutationMessage) {
        return delegateCompletion(
          `delegate-${scenario.seed}-initial-transaction`,
          'accounting',
          transactionDraftRequest(scenario.initialKnown),
        );
      }
      if (userText === scenario.prerequisiteMessage) {
        return delegateCompletion(
          `delegate-${scenario.seed}-transaction-update`,
          'accounting',
          transactionDraftRequest(scenario.prerequisiteKnown),
        );
      }
    }
    if (hasFunctionTool(body, 'delegateTeam')
      && lastMessageRole(body) === 'tool'
      && userText === scenario.prerequisiteMessage
      && checkedContext.includes(scenario.categoryAccount.name)) {
      return delegateCompletion(
        `delegate-${scenario.seed}-category-prerequisite`,
        'accounting',
        categoryChartRequest(scenario),
      );
    }
    if (userText.includes('Safe checked context:')) {
      const awaitingConfirmation = userText.includes('"effectState":"awaiting_confirmation"');
      return {
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: awaitingConfirmation
            ? `I’ll add ${scenario.categoryAccount.name} as a new ${scenario.categoryAccount.accountingClass} category in ${scenario.currency}, then record ${scenario.currency} ${scenario.amount} with ${scenario.paymentAccount.name} dated ${scenario.occurredOn}. Would you like me to proceed?`
            : `I recorded ${scenario.currency} ${scenario.amount} with ${scenario.paymentAccount.name} on ${scenario.expectedDate} under ${scenario.categoryAccount.name}.`,
        },
      };
    }
    if (userText === scenario.queryMessage && containsMaterialFacts(checkedContext, scenario)) {
      return {
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: `The household has a ${scenario.currency} ${scenario.amount} transaction with ${scenario.paymentAccount.name} on ${scenario.expectedDate} under ${scenario.categoryAccount.name}.`,
        },
      };
    }
    return {
      finishReason: 'stop',
      message: { role: 'assistant', content: 'I could not verify the requested accounting facts.' },
    };
  };
}

function delegateCompletion(
  id: string,
  team: 'accounting' | 'query',
  request: Record<string, unknown>,
) {
  return {
    finishReason: 'tool_calls' as const,
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id,
        type: 'function',
        function: {
          name: 'delegateTeam',
          arguments: JSON.stringify({ team, request }),
        },
      }],
    },
  };
}

function transactionDraftRequest(known: Record<string, string>): Record<string, unknown> {
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

function clarificationText(tokens: readonly string[]): string {
  if (tokens.includes('Takeout')) {
    return 'I don’t have a Takeout category. Dining is available; which category should I use?';
  }
  if (tokens.includes('payment_account')) return 'Which payment account should I use?';
  if (tokens.includes('occurred_on')) return 'What valid date did the transaction occur on?';
  if (tokens.length === 1 && tokens[0] === 'category') return 'Which category should I use?';
  if (tokens.length === 1 && tokens[0] === 'amount') return 'What amount should I record?';
  if (tokens.length === 1 && tokens[0] === 'currency') return 'Which currency should I use?';
  return 'Which account, date, and category should I use?';
}

function transactionRequest(scenario: TransactionRequestScenario): Record<string, unknown> {
  return {
    schemaName: 'accounting-lead-request',
    schemaVersion: 1,
    intent: 'transaction_capture',
    request: {
      schemaName: 'transaction-capture-request-draft',
      schemaVersion: 1,
      instruction: 'Record the requested transaction.',
      known: {
        amount: scenario.amount,
        currency: scenario.currency,
        occurredOn: scenario.occurredOn,
        paymentAccountName: scenario.requestPaymentAccountName ?? scenario.paymentAccount.name,
        categoryName: scenario.requestCategoryAccountName ?? scenario.categoryAccount.name,
      },
    },
  };
}

function queryRequest(): Record<string, unknown> {
  return {
    schemaName: 'query-lead-request-draft',
    schemaVersion: 1,
    businessQuestion: 'List the household transactions.',
    requiredCalculations: [],
    coverage: ['categorized transactions'],
  };
}

function chartRequest(scenario: AccountFactsScenario): Record<string, unknown> {
  return {
    schemaName: 'accounting-lead-request',
    schemaVersion: 1,
    intent: 'chart_of_accounts',
    request: {
      schemaName: 'chart-work-request-draft',
      schemaVersion: 1,
      action: 'create_account',
      instruction: `Create ${scenario.accountName}.`,
      known: {
        accountName: scenario.accountName,
        accountingClass: scenario.accountingClass,
        normalBalance: scenario.normalBalance,
        nativeCurrency: scenario.currency,
      },
    },
  };
}

function categoryChartRequest(scenario: MissingCategoryPrerequisiteScenario): Record<string, unknown> {
  return chartRequest({
    accountName: scenario.categoryAccount.name,
    accountingClass: scenario.categoryAccount.accountingClass,
    normalBalance: scenario.categoryAccount.normalBalance,
    currency: scenario.currency,
    timezone: scenario.timezone,
  });
}

function accountQueryRequest(): Record<string, unknown> {
  return {
    schemaName: 'query-lead-request-draft',
    schemaVersion: 1,
    businessQuestion: 'List the household accounts.',
    requiredCalculations: [],
    coverage: ['account list'],
  };
}

async function seedScenario(
  pool: Pool,
  scenario: Pick<DirectTransactionScenario, 'currency' | 'timezone' | 'paymentAccount' | 'categoryAccount'>,
  options: { includeTargetCategory?: boolean } = {},
): Promise<void> {
  const household = await pool.query<{ id: string }>(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1, $2, $3) RETURNING id::text`,
    [householdId, scenario.currency, scenario.timezone],
  );
  const householdKey = household.rows[0]!.id;
  const book = await pool.query<{ id: string }>(
    `INSERT INTO accounting.books (book_id, household_id, name)
     VALUES ($1, $2, 'Household Book') RETURNING id::text`,
    [bookId, householdKey],
  );
  await pool.query(
    `INSERT INTO accounting.book_configurations
       (configuration_id, household_id, book_id, reporting_currency, effective_from)
     VALUES ($1, $2, $3, $4, DATE '2026-01-01')`,
    [bookConfigurationId, householdKey, book.rows[0]!.id, scenario.currency],
  );
  await pool.query(
    `INSERT INTO accounting.periods
       (period_id, household_id, book_id, period_start, period_end)
     VALUES ($1, $2, $3, DATE '2026-07-01', DATE '2026-07-31')`,
    [periodId, householdKey, book.rows[0]!.id],
  );
  await pool.query(
    `INSERT INTO accounting.accounts
       (account_id, household_id, book_id, name, accounting_class, normal_balance, native_currency)
     VALUES
       ($1, $3, $4, $5, $6, $7, $8),
       ($2, $3, $4, $9, $10, $11, $8)`,
    [
      paymentAccountId,
      categoryAccountId,
      householdKey,
      book.rows[0]!.id,
      scenario.paymentAccount.name,
      scenario.paymentAccount.accountingClass,
      scenario.paymentAccount.normalBalance,
      scenario.currency,
      options.includeTargetCategory === false ? 'Existing Category' : scenario.categoryAccount.name,
      options.includeTargetCategory === false ? 'expense' : scenario.categoryAccount.accountingClass,
      options.includeTargetCategory === false ? 'debit' : scenario.categoryAccount.normalBalance,
    ],
  );
}

async function seedAccountScenario(pool: Pool, scenario: AccountFactsScenario): Promise<void> {
  const household = await pool.query<{ id: string }>(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1, $2, $3) RETURNING id::text`,
    [householdId, scenario.currency, scenario.timezone],
  );
  const householdKey = household.rows[0]!.id;
  const book = await pool.query<{ id: string }>(
    `INSERT INTO accounting.books (book_id, household_id, name)
     VALUES ($1, $2, 'Household Book') RETURNING id::text`,
    [bookId, householdKey],
  );
  await pool.query(
    `INSERT INTO accounting.book_configurations
       (configuration_id, household_id, book_id, reporting_currency, effective_from)
     VALUES ($1, $2, $3, $4, DATE '2026-01-01')`,
    [bookConfigurationId, householdKey, book.rows[0]!.id, scenario.currency],
  );
  await pool.query(
    `INSERT INTO accounting.accounts
       (account_id, household_id, book_id, name, accounting_class, normal_balance, native_currency)
     VALUES ($1, $2, $3, 'Existing Cash', 'asset', 'debit', $4)`,
    [paymentAccountId, householdKey, book.rows[0]!.id, scenario.currency],
  );
}

async function sendMessage(
  server: ProductionGatewayServerHandle,
  scenario: { seed: number; receivedAt: string },
  body: string,
  ordinal: number,
  targetConversationId = conversationId,
): Promise<Response> {
  return fetch(`${server.baseUrl}/plus-one/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(InboundChannelMessageSchemaV1.parse({
      schemaName: 'inbound-channel-message',
      schemaVersion: 1,
      conversationId: targetConversationId,
      householdId,
      channel: 'telegram',
      externalMessageId: `telegram:generated:${scenario.seed}:${ordinal}`,
      receivedAt: scenario.receivedAt,
      speaker: { principalRef: 'telegram:user:42', displayName: 'Adam' },
      body,
      attachments: [],
      metadata: { destination: { chatId: 'telegram-chat-42' } },
    })),
  });
}

async function accountEffectCounts(pool: Pool): Promise<{
  accounts: number;
  journals: number;
  commands: number;
  receipts: number;
  readbacks: number;
  confirmations: number;
}> {
  const result = await pool.query<{
    accounts: number;
    journals: number;
    commands: number;
    receipts: number;
    readbacks: number;
    confirmations: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM accounting.accounts) AS accounts,
       (SELECT count(*)::int FROM accounting.journals) AS journals,
       (SELECT count(*)::int FROM operations.mutation_commands) AS commands,
       (SELECT count(*)::int FROM operations.mutation_receipts) AS receipts,
       (SELECT count(*)::int FROM operations.mutation_readbacks) AS readbacks,
       (SELECT count(*)::int FROM operations.external_confirmations) AS confirmations`,
  );
  return result.rows[0]!;
}

async function expectAccountState(
  pool: Pool,
  scenario: AccountCreationScenario,
  before: Awaited<ReturnType<typeof accountEffectCounts>>,
): Promise<void> {
  expect(await accountEffectCounts(pool)).toEqual({
    accounts: before.accounts + 1,
    journals: before.journals,
    commands: before.commands + 1,
    receipts: before.receipts + 1,
    readbacks: before.readbacks + 1,
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
       AND lower(name) = lower($2)`,
    [householdId, scenario.accountName],
  )).rows).toEqual([{
    name: scenario.accountName,
    accounting_class: scenario.accountingClass,
    normal_balance: scenario.normalBalance,
    native_currency: scenario.currency,
  }]);
}

async function effectCounts(pool: Pool): Promise<{
  journals: number;
  postings: number;
  commands: number;
  receipts: number;
  readbacks: number;
}> {
  const result = await pool.query<{
    journals: number;
    postings: number;
    commands: number;
    receipts: number;
    readbacks: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM accounting.journals) AS journals,
       (SELECT count(*)::int FROM accounting.postings) AS postings,
       (SELECT count(*)::int FROM operations.mutation_commands) AS commands,
       (SELECT count(*)::int FROM operations.mutation_receipts) AS receipts,
       (SELECT count(*)::int FROM operations.mutation_readbacks) AS readbacks`,
  );
  return result.rows[0]!;
}

async function prerequisiteEffectCounts(pool: Pool): Promise<{
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

async function expectTransactionState(
  pool: Pool,
  scenario: DirectTransactionScenario,
  before: Awaited<ReturnType<typeof effectCounts>>,
): Promise<void> {
  expect(await effectCounts(pool)).toEqual({
    journals: before.journals + 1,
    postings: before.postings + 2,
    commands: before.commands + 1,
    receipts: before.receipts + 1,
    readbacks: before.readbacks + 1,
  });
  await expectTransactionJournal(pool, scenario);
}

async function expectPrerequisiteTransactionState(
  pool: Pool,
  scenario: MissingCategoryPrerequisiteScenario,
  before: Awaited<ReturnType<typeof prerequisiteEffectCounts>>,
): Promise<void> {
  expect(await prerequisiteEffectCounts(pool)).toEqual({
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
       AND lower(name) = lower($2)`,
    [householdId, scenario.categoryAccount.name],
  )).rows).toEqual([{
    name: scenario.categoryAccount.name,
    accounting_class: scenario.categoryAccount.accountingClass,
    normal_balance: scenario.categoryAccount.normalBalance,
    native_currency: scenario.currency,
  }]);
  await expectTransactionJournal(pool, scenario);
}

async function expectTransactionJournal(
  pool: Pool,
  scenario: DirectTransactionScenario,
): Promise<void> {
  const result = await pool.query<{
    occurred_on: string;
    transaction_currency: string;
    transaction_amount: string;
    period_start: string;
    period_end: string;
    accounts: string[];
    directions: Record<string, string>;
  }>(
    `SELECT journal.occurred_on::text, journal.transaction_currency,
       max(posting.transaction_amount)::text AS transaction_amount,
       period.period_start::text, period.period_end::text,
       array_agg(account.name ORDER BY account.name) AS accounts,
       jsonb_object_agg(account.name, posting.direction) AS directions
     FROM accounting.journals journal
     JOIN accounting.periods period ON period.id = journal.period_id
     JOIN accounting.postings posting ON posting.journal_id = journal.id
     JOIN accounting.accounts account ON account.id = posting.account_id
     GROUP BY journal.id, journal.occurred_on, journal.transaction_currency,
       period.period_start, period.period_end`,
  );
  const period = calendarMonthBounds(scenario.expectedDate);
  expect(result.rows).toEqual([{
    occurred_on: scenario.expectedDate,
    transaction_currency: scenario.currency,
    transaction_amount: amountAtLedgerScale(scenario.amount),
    period_start: period.start,
    period_end: period.end,
    accounts: [scenario.paymentAccount.name, scenario.categoryAccount.name].sort(),
    directions: scenario.categoryAccount.accountingClass === 'income'
      ? {
          [scenario.paymentAccount.name]: 'debit',
          [scenario.categoryAccount.name]: 'credit',
        }
      : {
          [scenario.paymentAccount.name]: 'credit',
          [scenario.categoryAccount.name]: 'debit',
        },
  }]);
}

function calendarMonthBounds(localDate: string): { start: string; end: string } {
  const [year, month] = localDate.split('-').map(Number);
  const start = `${year!.toString().padStart(4, '0')}-${month!.toString().padStart(2, '0')}-01`;
  const endDate = new Date(Date.UTC(year!, month!, 0));
  const end = `${endDate.getUTCFullYear().toString().padStart(4, '0')}-${(endDate.getUTCMonth() + 1)
    .toString().padStart(2, '0')}-${endDate.getUTCDate().toString().padStart(2, '0')}`;
  return { start, end };
}

function amountAtLedgerScale(amount: string): string {
  const [whole, fraction = ''] = amount.split('.');
  return `${whole}.${fraction.padEnd(12, '0')}`;
}

function containsMaterialFacts(text: string, scenario: DirectTransactionScenario): boolean {
  const normalized = normalizedText(text);
  return normalized.includes(normalizedText(scenario.currency))
    && normalized.includes(normalizedText(scenario.amount))
    && normalized.includes(normalizedText(scenario.paymentAccount.name))
    && normalized.includes(normalizedText(scenario.categoryAccount.name))
    && normalized.includes(normalizedText(scenario.expectedDate));
}

function normalizedText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function containsAccountFacts(text: string, scenario: AccountFactsScenario): boolean {
  return text.includes(scenario.accountName)
    && text.includes(scenario.currency)
    && text.includes(scenario.accountingClass)
    && text.includes(scenario.normalBalance);
}

function expectAccountFacts(body: string | undefined, scenario: AccountFactsScenario): void {
  expect(body).toContain(scenario.accountName);
  expect(body).toContain(scenario.currency);
  expect(body).toMatch(new RegExp(scenario.accountingClass, 'i'));
  expect(body).toMatch(new RegExp(scenario.normalBalance, 'i'));
}

function expectMaterialFacts(
  body: string | undefined,
  scenario: DirectTransactionScenario,
  completionPattern?: RegExp,
): void {
  expect(body).toContain(scenario.currency);
  expect(body).toContain(scenario.amount);
  expect(body).toContain(scenario.paymentAccount.name);
  expect(body).toContain(scenario.categoryAccount.name);
  expect(body).toContain(scenario.expectedDate);
  if (completionPattern !== undefined) expect(body).toMatch(completionPattern);
}

function expectNoImplementationDetails(body: string | undefined): void {
  expect(body).not.toMatch(
    /safely|internal|schema|readback|native_currency|QueryResult|team status|maker|checker|reporting\./i,
  );
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

function lastMessageRole(body: Record<string, unknown>): string | undefined {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const message = messages.at(-1);
  return typeof message === 'object' && message !== null && !Array.isArray(message)
    && typeof message.role === 'string'
    ? message.role
    : undefined;
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

function databaseEnvironment(testContext: PostgresTestContext): NodeJS.ProcessEnv {
  return {
    DATABASE_MIGRATOR_URL: testContext.migratorUrl,
    DATABASE_ACCOUNTING_URL: testContext.roleUrls.accounting,
    DATABASE_PLANNING_URL: testContext.roleUrls.planning,
    DATABASE_OPERATIONS_URL: testContext.roleUrls.operations,
    DATABASE_QUERY_URL: testContext.roleUrls.query,
    DATABASE_MEMORY_URL: testContext.roleUrls.memory,
  };
}

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const conversationId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const bookId = 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const bookConfigurationId = 'bookconfig_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const periodId = 'period_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const paymentAccountId = 'account_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const categoryAccountId = 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K';
