import { describe, expect, it } from 'vitest';
import { OrchestratorFinalResponseSchemaV1 } from '@plus-one/contracts';
import { channelFormatProcessor, mandatoryPolicyProcessor, runOutputProcessors } from './output-processors.js';

const baseResponse = OrchestratorFinalResponseSchemaV1.parse({
  schemaName: 'orchestrator-final-response',
  schemaVersion: 1,
  responseId: 'response-2026-06-22-001',
  householdId: 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  conversationId: 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K',
  body: 'You were under budget. Plus One is an AI assistant, not a licensed financial professional.',
  policyBoundary: 'personalized_finance',
  citations: [{ label: 'June budget variance', artifactId: 'artifact_01JNZQ4A9B8C7D6E5F4G3H2J1K' }],
  assumptions: ['June transactions are fully imported.'],
  freshness: ['Budget projection refreshed 2026-06-22.'],
  disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
  unsupportedCapabilities: [],
  recommendationActions: ['Move $50 from dining to groceries next month.'],
  delivery: { channel: 'telegram', destination: { chatId: 'telegram-chat-42' }, format: 'plain_text' },
  responseHash: 'a'.repeat(64),
  createdAt: '2026-06-22T10:00:00.000Z',
});

describe('output processors', () => {
  it('passes a personalized finance response with citations, freshness, and disclaimer', () => {
    expect(runOutputProcessors(baseResponse).status).toBe('passed');
  });

  it('blocks informational-only responses that contain recommendation actions', () => {
    expect(mandatoryPolicyProcessor.process({
      ...baseResponse,
      policyBoundary: 'informational_only',
      recommendationActions: ['Buy the allocation we discussed.'],
    })).toMatchObject({
      status: 'blocked',
      issues: ['informational_recommendation_action'],
    });
  });

  it('blocks financial responses with an incomplete disclaimer', () => {
    expect(mandatoryPolicyProcessor.process({
      ...baseResponse,
      disclaimer: 'Plus One is an AI assistant.',
    })).toMatchObject({
      status: 'blocked',
      issues: ['missing_financial_professional_disclaimer'],
    });
  });

  it('blocks tax or insurance content unless marked unsupported', () => {
    expect(mandatoryPolicyProcessor.process({
      ...baseResponse,
      unsupportedCapabilities: ['tax'],
    })).toMatchObject({
      status: 'blocked',
      issues: ['unsupported_capability_not_declared'],
    });
  });

  it('passes explicitly unsupported tax or insurance responses without recommendations', () => {
    expect(mandatoryPolicyProcessor.process({
      ...baseResponse,
      body: 'Tax support is unsupported in this version.',
      policyBoundary: 'unsupported_capability',
      unsupportedCapabilities: ['tax'],
      recommendationActions: [],
    }).status).toBe('passed');
  });

  it('blocks stale freshness and overlong Telegram output', () => {
    expect(mandatoryPolicyProcessor.process({
      ...baseResponse,
      freshness: ['stale projection; refresh required'],
    })).toMatchObject({
      status: 'blocked',
      issues: ['stale_freshness'],
    });

    expect(channelFormatProcessor.process({
      ...baseResponse,
      body: 'x'.repeat(4097),
    })).toMatchObject({
      status: 'blocked',
      issues: ['telegram_body_too_long'],
    });
  });
});
