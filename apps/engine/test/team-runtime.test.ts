import { describe, expect, it, vi } from 'vitest';
import { EvidenceRequestSchemaV1, InboundChannelMessageSchemaV1 } from '@plus-one/contracts';
import { queryTeamDefinition } from '@plus-one/query';
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

describe('normalizeAccountingLeadRequest', () => {
  it('canonicalizes transaction capture requests from inbound context', async () => {
    const pools = {
      accounting: {
        query: vi.fn(async () => ({ rows: [{ book_id: 'book_01JNZQ4A9B8C7D6E5F4G3H2J1K' }] })),
      },
    } as never;

    const normalized = await normalizeAccountingLeadRequest(pools, message, {
      schemaName: 'accounting-lead-request',
      schemaVersion: 1,
      intent: 'transaction_capture',
      request: {
        description: 'buying a burger',
        amount: 10,
        currency: 'USD',
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
        explicitInstruction: true,
        instruction: 'add $10 of buying a burger',
        known: {
          amount: '10.00',
          currency: 'USD',
        },
      },
    });
  });
});

describe('normalizeQueryLeadRequest', () => {
  it('canonicalizes a thin account-list request from inbound context', () => {
    const normalized = normalizeQueryLeadRequest(message, {
      businessQuestion: 'List our accounts.',
    });

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

  it('keeps a valid EvidenceRequestV1 unchanged', () => {
    const request = EvidenceRequestSchemaV1.parse({
      schemaName: 'evidence-request',
      schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      requestId: 'evidence_01JZZZZZZZZZZZZZZZZZZZZZZZ',
      businessQuestion: 'What are our balances?',
      intendedUse: 'household_finance_answer',
      timeframe: { start: '2026-06-01', end: '2026-06-24' },
      desiredGrain: ['household', 'account'],
      filters: [],
      requiredFreshness: 'latest available reporting projection',
      requiredCalculations: [],
      coverage: ['balance snapshot'],
    });

    expect(normalizeQueryLeadRequest(message, request)).toEqual(request);
  });
});

describe('makerInputForLeadWorkItem', () => {
  it('uses the normalized Query request as query-evidence maker input, but leaves query-analyst maker input unchanged', () => {
    const normalized = normalizeQueryLeadRequest(message, {
      businessQuestion: 'List our accounts.',
    });
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
    expect(makerInputForLeadWorkItem(queryTeamDefinition, 'query-analyst', analystInput, normalized))
      .toEqual(analystInput);
  });
});

describe('deterministicLeadPlanForRequest', () => {
  it('builds the one valid Query lead plan for the normalized account-list slice', () => {
    const request = normalizeQueryLeadRequest(message, {
      businessQuestion: 'List our accounts.',
    });

    expect(deterministicLeadPlanForRequest(queryTeamDefinition, request)).toEqual({
      schemaName: 'team-lead-plan',
      schemaVersion: 1,
      recommendedStrategyName: 'single-maker-checker',
      work: [{ workCellId: 'query-evidence', makerInput: request }],
      stopCondition: { code: 'query-answer', description: 'Return one checked query answer.' },
    });
  });

  it('leaves non-account-list Query requests on the modeled team-lead path', () => {
    const request = EvidenceRequestSchemaV1.parse({
      schemaName: 'evidence-request',
      schemaVersion: 1,
      householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
      requestId: 'evidence_01JZZZZZZZZZZZZZZZZZZZZZZZ',
      businessQuestion: 'What are our balances?',
      intendedUse: 'household_finance_answer',
      timeframe: { start: '2026-06-01', end: '2026-06-24' },
      desiredGrain: ['household', 'account'],
      filters: [],
      requiredFreshness: 'latest available reporting projection',
      requiredCalculations: [],
      coverage: ['balance snapshot'],
    });

    expect(deterministicLeadPlanForRequest(queryTeamDefinition, request)).toBeUndefined();
  });
});
