import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationScheduler, type SchedulerClaim } from './application-scheduler.js';
import {
  DeliveryRecordSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  ScheduledRunSchemaV1,
  TeamResultEnvelopeSchemaV2,
} from '@plus-one/contracts';
import {
  configureLogging,
  parseLogEnvelope,
  type LogEnvelopeV1,
} from '../logging/index.js';

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

function teamResult() {
  return TeamResultEnvelopeSchemaV2.parse({
    schemaName: 'team-result',
    schemaVersion: 2,
    householdId,
    taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
    team: 'query',
    status: 'failed',
    claims: [],
    assumptions: [],
    uncertainty: [],
    freshness: [],
    coverage: [],
    makerArtifacts: [],
    checkerVerdicts: [],
    selectedSkill: {
      skillName: 'scheduled-brief',
      skillVersion: 1,
      contentHash: 'a'.repeat(64),
    },
    strategyName: 'single-maker-checker',
    stopCondition: { code: 'scheduled-brief', description: 'Produce a scheduled briefing.' },
    completionReason: 'Team result requires orchestrator reconciliation.',
    outstanding: ['orchestrator_reconciliation'],
    effect: { state: 'none' },
  });
}

function claim(overrides: {
  scheduledFor?: string;
  target?: SchedulerClaim['target'];
  maxRetries?: number;
  missedRunPolicy?: SchedulerClaim['missedRunPolicy'];
  taskId?: string;
  requiredContextSchema?: { schemaName: string; schemaVersion: number };
  requiredContext?: unknown;
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
    ...(overrides.taskId === undefined ? {} : { taskId: overrides.taskId }),
    createdAt: now,
    updatedAt: now,
  });
  return {
    ...run,
    target: overrides.target ?? { kind: 'team_lead', team: 'query' },
    timeoutMs: 60_000,
    maxRetries: overrides.maxRetries ?? 0,
    requiredContextSchema: overrides.requiredContextSchema ?? { schemaName: 'weekly-briefing-context', schemaVersion: 1 },
    requiredContext: overrides.requiredContext ?? { lookbackDays: 7 },
    deliveryBehavior: { mode: 'deliver_final_response' },
    overlapPolicy: 'skip',
    missedRunPolicy: overrides.missedRunPolicy ?? 'run_once',
  };
}

describe('ApplicationScheduler', () => {
  it('logs scheduler lifecycle metadata without scheduled content', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-scheduler-'));
    const logging = configureLogging({ homeDirectory });
    const repository = {
      claimDueRuns: vi.fn(async () => [claim({ taskId: 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K' })]),
      completeRun: vi.fn(async (_input) => ({ ...claim(), status: _input.status })),
    };
    const scheduler = new ApplicationScheduler({
      repository,
      targets: {
        orchestrator: vi.fn(async () => finalResponse),
        teamLead: vi.fn(async () => teamResult()),
        orchestratorReconciler: { reconcile: vi.fn(async () => finalResponse) },
      },
      delivery: { deliver: vi.fn(async () => ({
        status: 'delivered' as const,
        sent: true as const,
        delivery: deliveryRecord(),
      })) },
    });

    try {
      await scheduler.dispatchDue(now, 5);
      await logging.flush();
      const records = (await readFile(join(homeDirectory, 'logs', 'agent.log'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => parseLogEnvelope(line))
        .filter((record): record is LogEnvelopeV1 => record !== undefined);
      expect(records).toContainEqual(expect.objectContaining({
        eventName: 'scheduler.run.completed',
        severityText: 'INFO',
        attributes: expect.objectContaining({
          'plus_one.household.id': 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K',
          'plus_one.task.id': 'task_01JNZQ4A9B8C7D6E5F4G3H2J1K',
          'scheduler.job.id': 'job_01JNZQ4A9B8C7D6E5F4G3H2J1K',
          'scheduler.occurrence.id': 'occurrence_01JNZQ4A9B8C7D6E5F4G3H2J1K',
          'scheduler.target.kind': 'team_lead',
          team: 'query',
          'retry.count': 1,
          status: 'succeeded',
          'duration.ms': expect.any(Number),
        }),
      }));
      expect(JSON.stringify(records)).not.toContain(finalResponse.body);
      expect(JSON.stringify(records)).not.toContain('telegram-chat-42');
    } finally {
      await logging.close();
    }
  });

  it('routes team-lead results through orchestrator reconciliation before delivery', async () => {
    const repository = {
      claimDueRuns: vi.fn(async () => [claim()]),
      completeRun: vi.fn(async (_input) => ({ ...claim(), status: _input.status })),
    };
    const teamLead = vi.fn(async () => teamResult());
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

  it('routes strict scheduled Working Memory review context to the read-only review target', async () => {
    const repository = {
      claimDueRuns: vi.fn(async () => [claim({
        target: { kind: 'orchestrator' },
        requiredContextSchema: { schemaName: 'working-memory-review-context', schemaVersion: 1 },
        requiredContext: {
          schemaName: 'working-memory-review-context',
          schemaVersion: 1,
          conversationId: finalResponse.conversationId,
          principalRef: 'telegram:user:1',
          mode: 'suggest',
        },
      })]),
      completeRun: vi.fn(async (_input) => ({ ...claim(), status: _input.status })),
    };
    const orchestrator = vi.fn();
    const orchestratorReview = vi.fn(async () => finalResponse);
    const deliver = vi.fn(async () => ({
      status: 'delivered' as const,
      sent: true as const,
      delivery: deliveryRecord(),
    }));
    const scheduler = new ApplicationScheduler({
      repository,
      targets: { orchestrator, orchestratorReview, teamLead: vi.fn(), orchestratorReconciler: { reconcile: vi.fn() } },
      delivery: { deliver },
    });

    await scheduler.dispatchDue(now, 5);
    expect(orchestrator).not.toHaveBeenCalled();
    expect(orchestratorReview).toHaveBeenCalledWith(expect.objectContaining({
      context: {
        schemaName: 'working-memory-review-context',
        schemaVersion: 1,
        conversationId: finalResponse.conversationId,
        principalRef: 'telegram:user:1',
        mode: 'suggest',
      },
    }));
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('fails invalid scheduled Working Memory review context without delivery', async () => {
    const repository = {
      claimDueRuns: vi.fn(async () => [claim({
        target: { kind: 'orchestrator' },
        requiredContextSchema: { schemaName: 'working-memory-review-context', schemaVersion: 1 },
        requiredContext: {
          schemaName: 'working-memory-review-context',
          schemaVersion: 1,
          conversationId: finalResponse.conversationId,
          principalRef: 'telegram:user:1',
          mode: 'apply',
        },
      })]),
      completeRun: vi.fn(async (_input) => ({ ...claim(), status: _input.status })),
    };
    const scheduler = new ApplicationScheduler({
      repository,
      targets: { orchestrator: vi.fn(), teamLead: vi.fn(), orchestratorReconciler: { reconcile: vi.fn() } },
      delivery: { deliver: vi.fn() },
    });

    await scheduler.dispatchDue(now, 5);
    expect(repository.completeRun).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      failureCategory: 'target_schema_validation',
    }));
  });

  it('skips stale missed runs when the job policy says skip', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-scheduler-'));
    const logging = configureLogging({ homeDirectory });
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

    try {
      await scheduler.dispatchDue(now, 5);
      expect(orchestrator).not.toHaveBeenCalled();
      expect(repository.completeRun).toHaveBeenCalledWith({ householdId, occurrenceId, status: 'skipped' });
      await logging.flush();
      const records = (await readFile(join(homeDirectory, 'logs', 'agent.log'), 'utf8'))
        .trim().split('\n').map((line) => parseLogEnvelope(line));
      expect(records).toContainEqual(expect.objectContaining({
        eventName: 'scheduler.run.skipped',
        severityText: 'INFO',
      }));
    } finally {
      await logging.close();
    }
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
    const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-scheduler-'));
    const logging = configureLogging({ homeDirectory });
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

    try {
      await scheduler.dispatchDue(now, 5);
      expect(repository.completeRun).toHaveBeenCalledWith({
        householdId,
        occurrenceId,
        status: 'timed_out',
        failureCategory: 'timeout',
      });
      await logging.flush();
      const records = (await readFile(join(homeDirectory, 'logs', 'agent.log'), 'utf8'))
        .trim().split('\n').map((line) => parseLogEnvelope(line));
      expect(records).toContainEqual(expect.objectContaining({
        eventName: 'scheduler.run.timed_out',
        severityText: 'ERROR',
      }));
    } finally {
      await logging.close();
    }
  });

  it('rejects invalid team-lead results before orchestrator reconciliation', async () => {
    const repository = {
      claimDueRuns: vi.fn(async () => [claim()]),
      completeRun: vi.fn(async (_input) => ({ ...claim(), status: _input.status })),
    };
    const reconcile = vi.fn(async () => finalResponse);
    const deliver = vi.fn();
    const scheduler = new ApplicationScheduler({
      repository,
      targets: {
        orchestrator: vi.fn(),
        teamLead: vi.fn(async () => ({ status: 'verified' })),
        orchestratorReconciler: { reconcile },
      },
      delivery: { deliver },
    });

    await scheduler.dispatchDue(now, 5);
    expect(reconcile).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(repository.completeRun).toHaveBeenCalledWith({
      householdId,
      occurrenceId,
      status: 'failed',
      failureCategory: 'target_schema_validation',
    });
  });

  it('emits one terminal failure when run completion persistence fails', async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), 'plus-one-scheduler-'));
    const logging = configureLogging({ homeDirectory });
    const failure = new Error('private scheduler database error');
    const repository = {
      claimDueRuns: vi.fn(async () => [claim({ target: { kind: 'orchestrator' } })]),
      completeRun: vi.fn(async () => {
        throw failure;
      }),
    };
    const scheduler = new ApplicationScheduler({
      repository,
      targets: {
        orchestrator: vi.fn(async () => finalResponse),
        teamLead: vi.fn(),
        orchestratorReconciler: { reconcile: vi.fn() },
      },
      delivery: { deliver: vi.fn(async () => ({
        status: 'delivered' as const,
        sent: true as const,
        delivery: deliveryRecord(),
      })) },
    });

    try {
      await expect(scheduler.dispatchDue(now, 5)).rejects.toBe(failure);
      await logging.flush();
      const records = (await readFile(join(homeDirectory, 'logs', 'agent.log'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => parseLogEnvelope(line))
        .filter((record): record is LogEnvelopeV1 => record !== undefined);
      expect(records.filter(({ eventName }) => (
        eventName === 'scheduler.run.completed'
        || eventName === 'scheduler.run.skipped'
        || eventName === 'scheduler.run.timed_out'
        || eventName === 'scheduler.run.failed'
      ))).toEqual([
        expect.objectContaining({
          eventName: 'scheduler.run.failed',
          severityText: 'ERROR',
          attributes: expect.objectContaining({
            status: 'failed',
            'failure.category': 'run_completion_failed',
          }),
        }),
      ]);
      expect(JSON.stringify(records)).not.toContain('private scheduler database error');
    } finally {
      await logging.close();
    }
  });
});
