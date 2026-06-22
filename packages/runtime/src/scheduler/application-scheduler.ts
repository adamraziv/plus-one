import type {
  OrchestratorFinalResponseV1,
  ScheduledRunV1,
} from '@plus-one/contracts';
import type { DeliveryResult } from '../delivery/final-delivery-handler.js';

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
        reconcile(input: { claim: SchedulerClaim; teamResult: unknown; signal: AbortSignal }): Promise<OrchestratorFinalResponseV1>;
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
    if (claim.missedRunPolicy === 'skip'
      && new Date(claim.scheduledFor).getTime() < new Date(now).getTime()) {
      return this.dependencies.repository.completeRun({
        householdId: claim.householdId,
        occurrenceId: claim.occurrenceId,
        status: 'skipped',
      });
    }

    try {
      const response = await this.runWithRetries(claim);
      const delivered = await this.dependencies.delivery.deliver(response);
      if (delivered.status !== 'delivered') {
        return this.dependencies.repository.completeRun({
          householdId: claim.householdId,
          occurrenceId: claim.occurrenceId,
          status: 'failed',
          failureCategory: delivered.status === 'blocked' ? 'processor_blocked' : `delivery_${delivered.status}`,
        });
      }
      return this.dependencies.repository.completeRun({
        householdId: claim.householdId,
        occurrenceId: claim.occurrenceId,
        status: 'succeeded',
        deliveryId: delivered.delivery.deliveryId,
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
      return this.dependencies.repository.completeRun({
        householdId: claim.householdId,
        occurrenceId: claim.occurrenceId,
        status: timedOut ? 'timed_out' : 'failed',
        failureCategory: timedOut ? 'timeout' : 'runtime_failure',
      });
    }
  }

  private async runWithRetries(claim: SchedulerClaim): Promise<OrchestratorFinalResponseV1> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= claim.maxRetries; attempt += 1) {
      const signal = AbortSignal.timeout(claim.timeoutMs);
      try {
        if (claim.target.kind === 'orchestrator') {
          return await this.dependencies.targets.orchestrator({ claim, signal });
        }
        const teamResult = await this.dependencies.targets.teamLead({ claim, signal });
        return await this.dependencies.targets.orchestratorReconciler.reconcile({
          claim,
          teamResult,
          signal,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'TimeoutError') throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Scheduled target failed');
  }
}
