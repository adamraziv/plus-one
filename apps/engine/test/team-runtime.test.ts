import { describe, expect, it, vi } from 'vitest';
import { EvidenceRequestSchemaV1, InboundChannelMessageSchemaV1 } from '@plus-one/contracts';
import { queryTeamDefinition } from '@plus-one/query';
import { accountingTeamDefinition } from '@plus-one/accounting';
import {
  deterministicLeadPlanForRequest,
  makerInputForLeadWorkItem,
  normalizeAccountingLeadRequest,
  normalizeQueryLeadRequest,
} from '../src/team-runtime.js';

const message = InboundChannelMessageSchemaV1.parse({
  schemaName: 'inbound-channel-message',
  schemaVersion: 1,
  conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  channel: 'telegram',
  externalMessageId: 'telegram-message-1',
  receivedAt: '2026-06-24T12:00:00.000Z',
  speaker: { principalRef: 'telegram:user:1' },
  body: 'add $10 of buying a burger',
  attachments: [],
  metadata: { destination: { chatId: 'telegram-chat-42' } },
});

function queryDraft(businessQuestion: string, extra: Record<string, unknown> = {}) {
  return {
    schemaName: 'query-lead-request-draft',
    schemaVersion: 1,
    businessQuestion,
    requiredCalculations: [],
    ...extra,
  };
}

function queryPools(grains: Record<string, readonly string[]>) {
  const query = vi.fn(async (_text: string, values: readonly unknown[]) => {
    const relationName = values[0];
    const grain = typeof relationName === 'string' ? grains[relationName] : undefined;
    return { rows: grain === undefined ? [] : [{ grain }] };
  });
  return { pools: { query: { query } } as never, query };
}

describe('normalizeAccountingLeadRequest', () => {
  it('canonicalizes typed transaction capture drafts without parsing prose', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ book_id: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' }] })
      .mockResolvedValueOnce({ rows: [{ account_id: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K', native_currency: 'USD' }] })
      .mockResolvedValueOnce({ rows: [{ account_id: 'account_01JNZQ4A9B8C7D6E5F4G3H2J3K', native_currency: 'USD' }] })
      .mockResolvedValueOnce({ rows: [{ period_id: 'period_01JNZQ4A9B8C7D6E5F4G3H2J4K' }] });
    const pools = {
      accounting: {
        query,
      },
    } as never;

    const normalized = await normalizeAccountingLeadRequest(pools, message, {
      schemaName: 'accounting-lead-request',
      schemaVersion: 1,
      intent: 'transaction_capture',
      request: {
        schemaName: 'transaction-capture-request-draft',
        schemaVersion: 1,
        instruction: 'Record a USD 10.00 burger purchase from checking on 2026-06-27 in dining out.',
        known: {
          amount: '10.00',
          currency: 'USD',
          occurredOn: '2026-06-27',
          paymentAccountName: 'checking',
          categoryName: 'dining out',
        },
      },
    });

    expect(normalized).toMatchObject({
      schemaName: 'accounting-lead-request',
      schemaVersion: 1,
      intent: 'transaction_capture',
      request: {
        schemaName: 'transaction-capture-request',
        schemaVersion: 1,
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        periodId: 'period_01JNZQ4A9B8C7D6E5F4G3H2J4K',
        explicitInstruction: true,
        instruction: 'Record a USD 10.00 burger purchase from checking on 2026-06-27 in dining out.',
        paymentAccountCurrency: 'USD',
        categoryAccountCurrency: 'USD',
        known: {
          amount: '10.00',
          currency: 'USD',
          paymentAccountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J2K',
          occurredOn: '2026-06-27',
          categoryAccountId: 'account_01JNZQ4A9B8C7D6E5F4G3H2J3K',
        },
      },
    });
  });

  it('does not extract amount or currency from message text when no typed draft supplies them', async () => {
    const pools = {
      accounting: {
        query: vi.fn(async () => ({ rows: [{ book_id: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' }] })),
      },
    } as never;

    const normalized = await normalizeAccountingLeadRequest(pools, message, {
      schemaName: 'accounting-lead-request',
      schemaVersion: 1,
      intent: 'transaction_capture',
      request: {},
    });

    expect(normalized).toMatchObject({
      request: {
        instruction: 'add $10 of buying a burger',
        known: {},
      },
    });
  });

  it('canonicalizes typed journal drafts by resolving the household book id', async () => {
    const pools = {
      accounting: {
        query: vi.fn(async () => ({ rows: [{ book_id: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' }] })),
      },
    } as never;

    const normalized = await normalizeAccountingLeadRequest(pools, message, {
      schemaName: 'accounting-lead-request',
      schemaVersion: 1,
      intent: 'journal',
      request: {
        operation: 'transfer',
        instruction: 'transfer $1000 from my savings to my checking account',
      },
    });

    expect(normalized).toMatchObject({
      schemaName: 'accounting-lead-request',
      schemaVersion: 1,
      intent: 'journal',
      request: {
        schemaName: 'journal-work-request',
        schemaVersion: 1,
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        operation: 'transfer',
        instruction: 'transfer $1000 from my savings to my checking account',
      },
    });
  });
});

describe('normalizeQueryLeadRequest', () => {
  it('canonicalizes a typed query draft from reporting metadata instead of model-supplied grain', async () => {
    const { pools, query } = queryPools({
      'reporting.categorized_transactions': ['household', 'posting'],
    });
    const normalized = await normalizeQueryLeadRequest(pools, message, queryDraft('List our transactions.', {
      desiredGrain: ['transaction', 'category'],
      coverage: ['categorized transactions'],
    }));

    const parsed = EvidenceRequestSchemaV1.parse(normalized);
    expect(parsed).toMatchObject({
      schemaName: 'evidence-request',
      schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      businessQuestion: 'List our transactions.',
      intendedUse: 'household_finance_answer',
      timeframe: { start: '2026-06-24', end: '2026-06-24' },
      desiredGrain: ['household', 'posting'],
      filters: [],
      requiredFreshness: 'latest available reporting projection',
      requiredCalculations: [],
      coverage: ['categorized transactions'],
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('reporting.relation_metadata'), [
      'reporting.categorized_transactions',
    ]);
    expect(parsed.requestId).toMatch(/^evidence_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('canonicalizes a typed account-list query draft from reporting metadata', async () => {
    const { pools } = queryPools({ 'reporting.accounts': ['household', 'account'] });
    const normalized = await normalizeQueryLeadRequest(pools, message, queryDraft('List our accounts.', {
      desiredGrain: ['account'],
      coverage: ['account list'],
    }));

    const parsed = EvidenceRequestSchemaV1.parse(normalized);
    expect(parsed).toMatchObject({
      schemaName: 'evidence-request',
      schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      businessQuestion: 'List our accounts.',
      intendedUse: 'household_finance_answer',
      timeframe: { start: '2026-06-24', end: '2026-06-24' },
      desiredGrain: ['household', 'account'],
      filters: [],
      requiredFreshness: 'latest available reporting projection',
      requiredCalculations: [],
      coverage: ['account list'],
    });
    expect(parsed.requestId).toMatch(/^evidence_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('uses generic coverage for legacy thin query objects instead of keyword regex', async () => {
    const { pools, query } = queryPools({});
    const normalized = await normalizeQueryLeadRequest(pools, message, {
      businessQuestion: 'What are our balances?',
    });

    const parsed = EvidenceRequestSchemaV1.parse(normalized);
    expect(parsed).toMatchObject({
      businessQuestion: 'What are our balances?',
      desiredGrain: ['household'],
      requiredCalculations: [],
      coverage: ['requested household finance answer'],
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('canonicalizes a full EvidenceRequestV1 when its model grain conflicts with reporting metadata', async () => {
    const { pools } = queryPools({
      'reporting.categorized_transactions': ['household', 'posting'],
    });
    const request = EvidenceRequestSchemaV1.parse({
      schemaName: 'evidence-request',
      schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J2K',
      requestId: 'evidence_01JZZZZZZZZZZZZZZZZZZZZZZZ',
      businessQuestion: 'List our transactions.',
      intendedUse: 'household_finance_answer',
      timeframe: { start: '2026-06-01', end: '2026-06-24' },
      desiredGrain: ['transaction', 'category'],
      filters: [],
      requiredFreshness: 'latest available reporting projection',
      requiredCalculations: [],
      coverage: ['categorized transactions'],
    });

    await expect(normalizeQueryLeadRequest(pools, message, request)).resolves.toEqual({
      ...request,
      householdId: message.householdId,
      desiredGrain: ['household', 'posting'],
    });
  });
});

describe('makerInputForLeadWorkItem', () => {
  it('uses the normalized Query request as query-evidence maker input, but leaves query-analyst maker input unchanged', async () => {
    const { pools } = queryPools({ 'reporting.accounts': ['household', 'account'] });
    const normalized = await normalizeQueryLeadRequest(pools, message, queryDraft('List our accounts.', {
      desiredGrain: ['household', 'account'],
      coverage: ['account list'],
    }));
    const analystInput = {
      schemaName: 'analyst-task',
      schemaVersion: 1,
      evidencePackageId: 'evidence_01JZZZZZZZZZZZZZZZZZZZZZZZ',
      request: normalized,
      queryResult: {
        schemaName: 'query-result',
        schemaVersion: 1,
        relationName: 'reporting.account_balances',
        grain: ['account'],
        rows: [],
        fieldDefinitions: ['account_name'],
        sourceReferences: ['reporting.account_balances'],
        freshness: 'latest available reporting projection',
        coverageWarnings: [],
      },
    };

    expect(makerInputForLeadWorkItem(queryTeamDefinition, 'query-evidence', { original: true }, normalized))
      .toEqual(normalized);
    const conflictingPlanRequest = EvidenceRequestSchemaV1.parse({
      schemaName: 'evidence-request',
      schemaVersion: 1,
      householdId: message.householdId,
      requestId: 'evidence_01JZZZZZZZZZZZZZZZZZZZZZZZ',
      businessQuestion: 'List our accounts.',
      intendedUse: 'household_finance_answer',
      timeframe: { start: '2026-06-01', end: '2026-06-24' },
      desiredGrain: ['category'],
      filters: [],
      requiredFreshness: 'latest available reporting projection',
      requiredCalculations: [],
      coverage: ['account list'],
    });
    expect(makerInputForLeadWorkItem(queryTeamDefinition, 'query-evidence', conflictingPlanRequest, normalized))
      .toEqual(normalized);
    expect(makerInputForLeadWorkItem(queryTeamDefinition, 'query-analyst', analystInput, normalized))
      .toEqual(analystInput);
  });
});

describe('deterministicLeadPlanForRequest', () => {
  it('builds the one valid Query lead plan for the normalized account-list slice', async () => {
    const { pools } = queryPools({ 'reporting.accounts': ['household', 'account'] });
    const request = await normalizeQueryLeadRequest(pools, message, queryDraft('List our accounts.', {
      desiredGrain: ['household', 'account'],
      coverage: ['account list'],
    }));

    expect(deterministicLeadPlanForRequest(queryTeamDefinition, request)).toEqual({
      schemaName: 'team-lead-plan',
      schemaVersion: 1,
      recommendedStrategyName: 'single-maker-checker',
      work: [{ workCellId: 'query-evidence', makerInput: request }],
      stopCondition: { code: 'query-answer', description: 'Return one checked query answer.' },
    });
  });

  it('builds the same deterministic Query plan for a normalized balances slice', async () => {
    const { pools } = queryPools({});
    const request = await normalizeQueryLeadRequest(pools, message, {
      businessQuestion: 'What are our balances?',
    });

    expect(deterministicLeadPlanForRequest(queryTeamDefinition, request)).toBeUndefined();
  });

  it('leaves calculation requests with known coverage on the modeled team-lead path', () => {
    const request = EvidenceRequestSchemaV1.parse({
      schemaName: 'evidence-request',
      schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      requestId: 'evidence_01JZZZZZZZZZZZZZZZZZZZZZZZ',
      businessQuestion: 'What is our average balance this month?',
      intendedUse: 'household_finance_answer',
      timeframe: { start: '2026-06-01', end: '2026-06-24' },
      desiredGrain: ['household', 'account'],
      filters: [],
      requiredFreshness: 'latest available reporting projection',
      requiredCalculations: ['average balance by account'],
      coverage: ['balance snapshot'],
    });

    expect(deterministicLeadPlanForRequest(queryTeamDefinition, request)).toBeUndefined();
  });

  it('leaves calculation-heavy Query requests on the modeled team-lead path', () => {
    const request = EvidenceRequestSchemaV1.parse({
      schemaName: 'evidence-request',
      schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      requestId: 'evidence_01JZZZZZZZZZZZZZZZZZZZZZZZ',
      businessQuestion: 'What are my top expenses this month?',
      intendedUse: 'expense_tracking',
      timeframe: { start: '2026-06-01', end: '2026-06-30' },
      desiredGrain: ['category'],
      filters: [],
      requiredFreshness: 'latest',
      requiredCalculations: ['sum'],
      coverage: ['all'],
    });

    expect(deterministicLeadPlanForRequest(queryTeamDefinition, request)).toBeUndefined();
  });

  it('uses deterministic Query evidence for explicit category spend coverage', () => {
    const request = EvidenceRequestSchemaV1.parse({
      schemaName: 'evidence-request',
      schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      requestId: 'evidence_01JZZZZZZZZZZZZZZZZZZZZZZZ',
      businessQuestion: 'What are my top expenses this month?',
      intendedUse: 'expense_tracking',
      timeframe: { start: '2026-06-01', end: '2026-06-30' },
      desiredGrain: ['household', 'month', 'category'],
      filters: [],
      requiredFreshness: 'latest',
      requiredCalculations: [],
      coverage: ['category spend monthly'],
    });

    expect(deterministicLeadPlanForRequest(queryTeamDefinition, request)).toEqual({
      schemaName: 'team-lead-plan',
      schemaVersion: 1,
      recommendedStrategyName: 'single-maker-checker',
      work: [{ workCellId: 'query-evidence', makerInput: request }],
      stopCondition: { code: 'query-answer', description: 'Return one checked query answer.' },
    });
  });

  it('uses deterministic Accounting routing for typed accounting requests', () => {
    const request = {
      schemaName: 'accounting-lead-request',
      schemaVersion: 1,
      intent: 'transaction_capture',
      request: {
        schemaName: 'transaction-capture-request',
        schemaVersion: 1,
        householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        bookId: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K',
        explicitInstruction: true,
        instruction: 'add $10 of buying a burger',
        known: { amount: '10.00', currency: 'USD' },
      },
    };

    expect(deterministicLeadPlanForRequest(accountingTeamDefinition, request)).toEqual({
      schemaName: 'team-lead-plan',
      schemaVersion: 1,
      recommendedStrategyName: 'single-maker-checker',
      work: [{ workCellId: 'transaction-capture', makerInput: request.request }],
      stopCondition: {
        code: 'checked-transaction-capture',
        description: 'Return one checked accounting result.',
      },
    });
  });
});
