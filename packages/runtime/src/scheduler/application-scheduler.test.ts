import { describe, expect, it, vi } from 'vitest';
import { ApplicationScheduler, type SchedulerClaim } from './application-scheduler.js';
import {
  DeliveryRecordSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  ScheduledRunSchemaV1,
} from '@plus-one/contracts';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const occurrenceId = 'occurrence_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const jobId = 'job_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const now = '2026-06-22T10:00:00.000Z';

const finalResponse = OrchestratorFinalResponseSchemaV1.parse({
  schemaName: 'orchestrator-final-response',
  schemaVersion: 1,
  responseId: 'response-2026-06-22-001',
  householdId,
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
  createdAt: now,
});

function deliveryRecord() {
  return DeliveryRecordSchemaV1.parse({
    schemaName: 'delivery-record',
    schemaVersion: 1,
    deliveryId: 'delivery_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    householdId,
    conversationId: finalResponse.conversationId,
    channel: 'telegram',
    idempotencyKey: 'delivery-key-1',
    responseHash: finalResponse.responseHash,
    status: 'delivered',
    destination: finalResponse.delivery.destination,
    platformMessageId: 'telegram-platform-123',
    attemptCount: 1,
    createdAt: now,
    updatedAt: now,
  });
}

function claim(overrides: {
  scheduledFor?: string;
  target?: SchedulerClaim['target'];
  maxRetries?: number;
  missedRunPolicy?: SchedulerClaim['missedRunPolicy'];
} = {}): SchedulerClaim {
  const run = ScheduledRunSchemaV1.parse({
    schemaName: 'scheduled-run',
    schemaVersion: 1,
    occurrenceId,
    jobId,
    jobVersion: 1,
    householdId,
    runKey: `${jobId}:1:${overrides.scheduledFor ?? now}`,
    scheduledFor: overrides.scheduledFor ?? now,
    status: 'claimed',
    attemptCount: 1,
    createdAt: now,
    updatedAt: now,
  });
  return {
    ...run,
    target: overrides.target ?? { kind: 'team_lead', team: 'query' },
    timeoutMs: 60_000,
    maxRetries: overrides.maxRetries ?? 0,
    requiredContext: { lookbackDays: 7 },
    deliveryBehavior: { mode: 'deliver_final_response' },
    overlapPolicy: 'skip',
    missedRunPolicy: overrides.missedRunPolicy ?? 'run_once',
  };
}

describe('ApplicationScheduler', () => {
  it('routes team-lead results through orchestrator reconciliation before delivery', async () => {
    const repository = {
      claimDueRuns: vi.fn(async () => [claim()]),
      completeRun: vi.fn(async (_input) => ({ ...claim(), status: _input.status })),
    };
    const teamLead = vi.fn(async () => ({ schemaName: 'team-result', schemaVersion: 1, status: 'verified' }));
    const reconcile = vi.fn(async () => finalResponse);
    const deliver = vi.fn(async () => ({
      status: 'delivered' as const,
      sent: true as const,
      delivery: deliveryRecord(),
    }));
    const scheduler = new ApplicationScheduler({
      repository,
      targets: { orchestrator: vi.fn(), teamLead, orchestratorReconciler: { reconcile } },
      delivery: { deliver },
    });

    await expect(scheduler.dispatchDue(now, 5)).resolves.toHaveLength(1);
    expect(teamLead.mock.invocationCallOrder[0]).toBeLessThan(reconcile.mock.invocationCallOrder[0] ?? 0);
    expect(reconcile.mock.invocationCallOrder[0]).toBeLessThan(deliver.mock.invocationCallOrder[0] ?? 0);
    expect(repository.completeRun).toHaveBeenCalledWith({
      householdId,
      occurrenceId,
      status: 'succeeded',
      deliveryId: 'delivery_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    });
  });

  it('skips stale missed runs when the job policy says skip', async () => {
    const repository = {
      claimDueRuns: vi.fn(async () => [claim({
        scheduledFor: '2026-06-22T09:00:00.000Z',
        missedRunPolicy: 'skip',
      })]),
      completeRun: vi.fn(async (_input) => ({ ...claim(), status: _input.status })),
    };
    const orchestrator = vi.fn();
    const scheduler = new ApplicationScheduler({
      repository,
      targets: { orchestrator, teamLead: vi.fn(), orchestratorReconciler: { reconcile: vi.fn() } },
      delivery: { deliver: vi.fn() },
    });

    await scheduler.dispatchDue(now, 5);
    expect(orchestrator).not.toHaveBeenCalled();
    expect(repository.completeRun).toHaveBeenCalledWith({ householdId, occurrenceId, status: 'skipped' });
  });

  it('uses bounded retries before marking a run successful', async () => {
    const repository = {
      claimDueRuns: vi.fn(async () => [claim({ target: { kind: 'orchestrator' }, maxRetries: 2 })]),
      completeRun: vi.fn(async (_input) => ({ ...claim(), status: _input.status })),
    };
    const orchestrator = vi.fn()
      .mockRejectedValueOnce(new Error('try again'))
      .mockRejectedValueOnce(new Error('try again'))
      .mockResolvedValueOnce(finalResponse);
    const scheduler = new ApplicationScheduler({
      repository,
      targets: { orchestrator, teamLead: vi.fn(), orchestratorReconciler: { reconcile: vi.fn() } },
      delivery: { deliver: vi.fn(async () => ({
        status: 'delivered' as const,
        sent: true as const,
        delivery: deliveryRecord(),
      })) },
    });

    await scheduler.dispatchDue(now, 5);
    expect(orchestrator).toHaveBeenCalledTimes(3);
    expect(repository.completeRun).toHaveBeenCalledWith({
      householdId,
      occurrenceId,
      status: 'succeeded',
      deliveryId: 'delivery_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    });
  });

  it('classifies timeout failures as timed out', async () => {
    const repository = {
      claimDueRuns: vi.fn(async () => [claim({ target: { kind: 'orchestrator' } })]),
      completeRun: vi.fn(async (_input) => ({ ...claim(), status: _input.status })),
    };
    const scheduler = new ApplicationScheduler({
      repository,
      targets: {
        orchestrator: vi.fn(async () => {
          throw new DOMException('expired', 'TimeoutError');
        }),
        teamLead: vi.fn(),
        orchestratorReconciler: { reconcile: vi.fn() },
      },
      delivery: { deliver: vi.fn() },
    });

    await scheduler.dispatchDue(now, 5);
    expect(repository.completeRun).toHaveBeenCalledWith({
      householdId,
      occurrenceId,
      status: 'timed_out',
      failureCategory: 'timeout',
    });
  });
});
