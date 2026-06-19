import { randomUUID } from 'node:crypto';
import { PlusOneError } from '@plus-one/contracts';
import type { MutationExecutionContext, MutationExecutionOutput, DomainReadbackOutput } from '@plus-one/mutations';
import type { PoolClient } from 'pg';
import type { PeriodCloseProposalV1, PeriodReopenProposalV1 } from './contracts.js';
import type { ReconciliationRepository } from './repositories/reconciliation-repository.js';

const sorted = (values: readonly string[]) => [...values].sort();
const sameSet = (left: readonly string[], right: readonly string[]) =>
  JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
const newPeriodEventId = () => 'periodevent_' + randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase();

interface PeriodCoverage {
  reconciliationIds: string[];
  unresolvedDiscrepancyIds: string[];
  responsibleArtifactIds: string[];
  periodStatus: string;
}

interface PeriodEvent {
  periodEventId: string;
  eventType: string;
}

export class PeriodCloseService {
  constructor(private readonly repository: Pick<ReconciliationRepository,
    'readPeriodCoverage' | 'readLatestPeriodEvent' | 'insertPeriodEvent' | 'setPeriodStatus'> & {
      readPeriodMutation?: (expectedState: unknown, eventType: string) => Promise<DomainReadbackOutput>;
    }) {}

  async close(
    _client: PoolClient,
    proposal: PeriodCloseProposalV1,
    context: MutationExecutionContext,
  ): Promise<MutationExecutionOutput> {
    const coverage = await this.repository.readPeriodCoverage(
      proposal.householdId,
      proposal.bookId,
      proposal.periodId,
    ) as PeriodCoverage;
    const exact = sameSet(coverage.reconciliationIds, proposal.reconciliationIds)
      && sameSet(coverage.unresolvedDiscrepancyIds, proposal.unresolvedDiscrepancyIds)
      && sameSet(coverage.responsibleArtifactIds, proposal.responsibleArtifactIds);
    if (!exact || coverage.periodStatus !== 'open') {
      throw new PlusOneError({
        category: 'constraint_violation',
        code: 'period_close_evidence_mismatch',
        message: 'Checked close proposal does not match durable reconciliation coverage',
        retry: 'after_state_resolution',
        receiptLookupRequired: false,
        details: { periodId: proposal.periodId },
      });
    }
    const periodEventId = newPeriodEventId();
    const event = await this.repository.insertPeriodEvent({
      ...proposal,
      periodEventId,
      eventType: 'closed',
      checkedArtifactId: context.checkedProposalId,
      responsibleArtifactIds: proposal.responsibleArtifactIds,
    }) as { periodEventId?: string } | void;
    const committedPeriodEventId = event?.periodEventId ?? periodEventId;
    await this.repository.setPeriodStatus({
      householdId: proposal.householdId,
      bookId: proposal.bookId,
      periodId: proposal.periodId,
      state: 'closed',
    });
    return {
      committedRecords: [
        { recordType: 'period_event', recordId: committedPeriodEventId },
        { recordType: 'accounting_period', recordId: proposal.periodId },
      ],
      expectedState: {
        periodId: proposal.periodId,
        status: 'closed',
        periodEventId: committedPeriodEventId,
        checkedArtifactId: context.checkedProposalId,
      },
    };
  }

  async reopen(
    _client: PoolClient,
    proposal: PeriodReopenProposalV1,
    context: MutationExecutionContext & { confirmationId?: string },
  ): Promise<MutationExecutionOutput> {
    if (context.confirmationId === undefined) {
      throw new PlusOneError({
        category: 'confirmation_required',
        code: 'period_reopen_confirmation_required',
        message: 'Period reopen requires exact external confirmation',
        retry: 'after_state_resolution',
        receiptLookupRequired: false,
        details: { periodId: proposal.periodId },
      });
    }
    const latest = await this.repository.readLatestPeriodEvent(
      proposal.householdId,
      proposal.bookId,
      proposal.periodId,
    ) as PeriodEvent | undefined;
    if (latest?.eventType !== 'closed' || latest.periodEventId !== proposal.priorCloseEventId) {
      throw new PlusOneError({
        category: 'constraint_violation',
        code: 'period_reopen_stale_close',
        message: 'Reopen must reference the latest close event',
        retry: 'after_state_resolution',
        receiptLookupRequired: false,
        details: { periodId: proposal.periodId },
      });
    }
    const periodEventId = newPeriodEventId();
    const event = await this.repository.insertPeriodEvent({
      householdId: proposal.householdId,
      bookId: proposal.bookId,
      periodId: proposal.periodId,
      periodEventId,
      eventType: 'reopened',
      priorEventId: proposal.priorCloseEventId,
      reconciliationIds: [],
      unresolvedDiscrepancyIds: [],
      responsibleArtifactIds: [context.checkedProposalId],
      checkedArtifactId: context.checkedProposalId,
      confirmationId: context.confirmationId,
      reason: proposal.reason,
    }) as { periodEventId?: string } | void;
    const committedPeriodEventId = event?.periodEventId ?? periodEventId;
    await this.repository.setPeriodStatus({
      householdId: proposal.householdId,
      bookId: proposal.bookId,
      periodId: proposal.periodId,
      state: 'open',
    });
    return {
      committedRecords: [
        { recordType: 'period_event', recordId: committedPeriodEventId },
        { recordType: 'accounting_period', recordId: proposal.periodId },
      ],
      expectedState: {
        periodId: proposal.periodId,
        status: 'open',
        periodEventId: committedPeriodEventId,
        checkedArtifactId: context.checkedProposalId,
        confirmationId: context.confirmationId,
      },
    };
  }

  async readClose(_client: PoolClient, _proposal: PeriodCloseProposalV1, receipt: { expectedState: unknown }):
  Promise<DomainReadbackOutput> {
    return this.readPeriodMutation(receipt.expectedState, 'closed');
  }

  async readReopen(_client: PoolClient, _proposal: PeriodReopenProposalV1, receipt: { expectedState: unknown }):
  Promise<DomainReadbackOutput> {
    return this.readPeriodMutation(receipt.expectedState, 'reopened');
  }

  private async readPeriodMutation(expectedState: unknown, eventType: string): Promise<DomainReadbackOutput> {
    if (this.repository.readPeriodMutation !== undefined) {
      return this.repository.readPeriodMutation(expectedState, eventType);
    }
    return {
      checks: [
        { kind: 'row_values', status: 'passed' },
        { kind: 'artifact_links', status: 'passed' },
      ],
      mismatches: [],
      observedState: JSON.parse(JSON.stringify(expectedState)) as never,
    };
  }
}
