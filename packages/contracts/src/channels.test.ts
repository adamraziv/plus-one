import { describe, expect, it } from 'vitest';
import {
  ChannelConversationSchemaV1,
  DeliveryRecordSchemaV1,
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  OutputProcessorResultSchemaV1,
  ScheduledJobSchemaV1,
  ScheduledRunSchemaV1,
} from './channels.js';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const conversationId = 'conversation_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const deliveryId = 'delivery_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const jobId = 'job_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const occurrenceId = 'occurrence_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const timestamp = '2026-06-22T10:00:00.000Z';

describe('channel and scheduling contracts', () => {
  it('keeps channel conversation metadata as routing data only', () => {
    expect(ChannelConversationSchemaV1.parse({
      schemaName: 'channel-conversation',
      schemaVersion: 1,
      conversationId,
      householdId,
      channel: 'telegram',
      channelType: 'direct',
      externalConversationId: 'telegram-chat-42',
      externalThreadId: 'telegram-thread-7',
      destination: { chatId: 'telegram-chat-42' },
      createdAt: timestamp,
      updatedAt: timestamp,
    }).destination).toEqual({ chatId: 'telegram-chat-42' });

    expect(() => ChannelConversationSchemaV1.parse({
      schemaName: 'channel-conversation',
      schemaVersion: 1,
      conversationId,
      householdId,
      channel: 'slack',
      channelType: 'channel',
      externalConversationId: 'C123',
      destination: { channelId: 'C123' },
      authorized: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    })).toThrow();
  });

  it('deduplicates inbound messages by platform message identity', () => {
    expect(InboundChannelMessageSchemaV1.parse({
      schemaName: 'inbound-channel-message',
      schemaVersion: 1,
      conversationId,
      householdId,
      channel: 'slack',
      externalMessageId: '1700000000.000100',
      receivedAt: timestamp,
      speaker: { principalRef: 'slack:user:U123', displayName: 'Alex' },
      body: 'How are we doing this month?',
      attachments: [],
      metadata: { teamId: 'T123' },
    }).externalMessageId).toBe('1700000000.000100');
  });

  it('requires final responses to carry policy and delivery evidence', () => {
    const response = OrchestratorFinalResponseSchemaV1.parse({
      schemaName: 'orchestrator-final-response',
      schemaVersion: 1,
      responseId: 'response-2026-06-22-001',
      householdId,
      conversationId,
      taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
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
      createdAt: timestamp,
    });

    expect(response.policyBoundary).toBe('personalized_finance');
    expect(() => OrchestratorFinalResponseSchemaV1.parse({
      ...response,
      disclaimer: '',
    })).toThrow();
  });

  it('captures processor outcomes as blocking or passing decisions', () => {
    expect(OutputProcessorResultSchemaV1.parse({
      schemaName: 'output-processor-result',
      schemaVersion: 1,
      processorName: 'mandatory-policy',
      processorVersion: 1,
      status: 'blocked',
      reason: 'Missing disclaimer.',
      issues: ['missing_disclaimer'],
      retryable: true,
    }).status).toBe('blocked');
  });

  it('preserves final delivery status for duplicate prevention', () => {
    expect(DeliveryRecordSchemaV1.parse({
      schemaName: 'delivery-record',
      schemaVersion: 1,
      deliveryId,
      householdId,
      conversationId,
      channel: 'telegram',
      idempotencyKey: 'delivery-key-1',
      responseHash: 'b'.repeat(64),
      status: 'delivered',
      destination: { chatId: 'telegram-chat-42' },
      platformMessageId: '12345',
      attemptCount: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).platformMessageId).toBe('12345');
  });

  it('requires explicit scheduled-job and run policies', () => {
    const job = ScheduledJobSchemaV1.parse({
      schemaName: 'scheduled-job',
      schemaVersion: 1,
      jobId,
      householdId,
      version: 3,
      target: { kind: 'team_lead', team: 'query' },
      purpose: 'Weekly cash-flow briefing',
      schedule: { kind: 'external', expression: 'weekly-monday-09:00' },
      timezone: 'America/New_York',
      nextEligibleRunAt: timestamp,
      requiredContextSchema: { schemaName: 'weekly-briefing-context', schemaVersion: 1 },
      requiredContext: { lookbackDays: 7 },
      deliveryBehavior: { mode: 'deliver_final_response', channel: 'slack', destination: { channelId: 'C123' } },
      overlapPolicy: 'skip',
      missedRunPolicy: 'run_once',
      timeoutMs: 60_000,
      maxRetries: 2,
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(job.target.kind).toBe('team_lead');

    expect(ScheduledRunSchemaV1.parse({
      schemaName: 'scheduled-run',
      schemaVersion: 1,
      occurrenceId,
      jobId,
      jobVersion: job.version,
      householdId,
      runKey: 'job_01JNZQ4A9B8C7D6E5F4G3H2J1K:3:2026-06-22T10:00:00.000Z',
      scheduledFor: timestamp,
      status: 'claimed',
      attemptCount: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).runKey).toContain(':3:');
  });
});
