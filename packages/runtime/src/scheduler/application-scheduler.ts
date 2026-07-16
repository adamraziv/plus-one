import type {
  OrchestratorFinalResponseV1,
  ScheduledRunV1,
  TeamResultEnvelopeV2,
} from '@plus-one/contracts';
import {
  OrchestratorFinalResponseSchemaV1,
  TeamResultEnvelopeSchemaV2,
} from '@plus-one/contracts';
import { ZodError } from 'zod';
import type { DeliveryResult } from '../delivery/final-delivery-handler.js';
import { getLogger, withLogContext } from '../logging/index.js';

export interface SchedulerClaim extends ScheduledRunV1 {
  target: { kind: 'orchestrator' } | { kind: 'team_lead'; team: string };
  timeoutMs: number;
  maxRetries: number;
  requiredContext: unknown;
  deliveryBehavior: unknown;
  overlapPolicy: 'skip' | 'allow';
  missedRunPolicy: 'skip' | 'run_once' | 'bounded_catch_up';
}

export interface SchedulerRepositoryPort {
  claimDueRuns(now: string, limit: number): Promise<SchedulerClaim[]>;
  completeRun(input: {
    householdId: string;
    occurrenceId: string;
    status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'skipped';
    taskId?: string;
    deliveryId?: string;
    failureCategory?: string;
  }): Promise<ScheduledRunV1>;
}

export class ApplicationScheduler {
  constructor(private readonly dependencies: {
    repository: SchedulerRepositoryPort;
    targets: {
      orchestrator(input: { claim: SchedulerClaim; signal: AbortSignal }): Promise<OrchestratorFinalResponseV1>;
      teamLead(input: { claim: SchedulerClaim; signal: AbortSignal }): Promise<unknown>;
      orchestratorReconciler: {
        reconcile(input: { claim: SchedulerClaim; teamResult: TeamResultEnvelopeV2; signal: AbortSignal }): Promise<OrchestratorFinalResponseV1>;
      };
    };
    delivery: { deliver(response: OrchestratorFinalResponseV1): Promise<DeliveryResult> };
  }) {}

  async dispatchDue(now: string, limit: number): Promise<ScheduledRunV1[]> {
    const claims = await this.dependencies.repository.claimDueRuns(now, limit);
    const completed: ScheduledRunV1[] = [];
    for (const claim of claims) completed.push(await this.dispatchClaim(claim, now));
    return completed;
  }

  private async dispatchClaim(claim: SchedulerClaim, now: string): Promise<ScheduledRunV1> {
    const logger = getLogger('runtime.scheduler');
    const startedAt = Date.now();
    const fields = {
      jobId: claim.jobId,
      occurrenceId: claim.occurrenceId,
      targetKind: claim.target.kind,
      ...(claim.target.kind === 'team_lead' ? { team: claim.target.team } : {}),
      retryCount: claim.attemptCount,
    };
    const logContext = claim.taskId === undefined
      ? { householdId: claim.householdId }
      : { householdId: claim.householdId, taskId: claim.taskId };
    return withLogContext(logContext, async () => {
      logger.info('scheduler.run.started', { fields });
      const logCompleted = (
        status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'skipped',
        failureCategory?: string,
      ): void => {
        const options = {
          fields: {
            ...fields,
            status,
            ...(failureCategory === undefined ? {} : { failureCategory }),
            durationMs: Date.now() - startedAt,
          },
        };
        if (status === 'succeeded' || status === 'skipped') {
          logger.info('scheduler.run.completed', options);
        } else {
          logger.warn('scheduler.run.completed', options);
        }
      };

      if (claim.missedRunPolicy === 'skip'
        && new Date(claim.scheduledFor).getTime() < new Date(now).getTime()) {
        const completed = await this.dependencies.repository.completeRun({
          householdId: claim.householdId,
          occurrenceId: claim.occurrenceId,
          status: 'skipped',
        });
        logCompleted('skipped');
        return completed;
      }

      try {
        const response = await this.runWithRetries(claim);
        const delivered = await this.dependencies.delivery.deliver(response);
        if (delivered.status !== 'delivered') {
          const failureCategory = delivered.status === 'blocked' ? 'processor_blocked' : `delivery_${delivered.status}`;
          const completed = await this.dependencies.repository.completeRun({
            householdId: claim.householdId,
            occurrenceId: claim.occurrenceId,
            status: 'failed',
            failureCategory,
          });
          logCompleted('failed', failureCategory);
          return completed;
        }
        const completed = await this.dependencies.repository.completeRun({
          householdId: claim.householdId,
          occurrenceId: claim.occurrenceId,
          status: 'succeeded',
          deliveryId: delivered.delivery.deliveryId,
        });
        logCompleted('succeeded');
        return completed;
      } catch (error) {
        const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
        const schemaFailed = error instanceof ZodError;
        const status = timedOut ? 'timed_out' : 'failed';
        const failureCategory = timedOut ? 'timeout'
          : schemaFailed ? 'target_schema_validation'
          : 'runtime_failure';
        const completed = await this.dependencies.repository.completeRun({
          householdId: claim.householdId,
          occurrenceId: claim.occurrenceId,
          status,
          failureCategory,
        });
        logCompleted(status, failureCategory);
        return completed;
      }
    });
  }

  private async runWithRetries(claim: SchedulerClaim): Promise<OrchestratorFinalResponseV1> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= claim.maxRetries; attempt += 1) {
      const signal = AbortSignal.timeout(claim.timeoutMs);
      try {
        if (claim.target.kind === 'orchestrator') {
          return OrchestratorFinalResponseSchemaV1.parse(
            await this.dependencies.targets.orchestrator({ claim, signal }),
          );
        }
        const teamResult = TeamResultEnvelopeSchemaV2.parse(
          await this.dependencies.targets.teamLead({ claim, signal }),
        );
        return OrchestratorFinalResponseSchemaV1.parse(
          await this.dependencies.targets.orchestratorReconciler.reconcile({ claim, teamResult, signal }),
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === 'TimeoutError') throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Scheduled target failed');
  }
}
