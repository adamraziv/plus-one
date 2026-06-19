import type { DomainReadbackOutput, MutationCommandHandler } from '@plus-one/mutations';
import { canonicalizeJson } from '@plus-one/runtime';
import type { PoolClient } from 'pg';
import {
  PeriodCloseProposalSchemaV1,
  PeriodReopenProposalSchemaV1,
  ReconciliationProposalSchemaV1,
  type PeriodCloseProposalV1,
  type PeriodReopenProposalV1,
  type ReconciliationProposalV1,
} from '../contracts.js';
import type { PeriodCloseService } from '../period-close-service.js';
import type { ReconciliationRepository } from '../repositories/reconciliation-repository.js';

export const createRecordReconciliationHandler = (
  repository: Pick<ReconciliationRepository,
    'insertReconciliation' | 'insertItems' | 'insertEvidenceLinks' | 'readReconciliation'>,
  repositoryForClient?: (client: PoolClient) => Pick<ReconciliationRepository,
    'insertReconciliation' | 'insertItems' | 'insertEvidenceLinks' | 'readReconciliation'>,
): MutationCommandHandler<ReconciliationProposalV1> => ({
  commandType: 'record_reconciliation',
  domainRole: 'accounting',
  inputSchema: ReconciliationProposalSchemaV1,
  inputSchemaIdentity: { schemaName: 'reconciliation-proposal', schemaVersion: 1 },
  confirmation: 'optional',
  requiredReadbackChecks: ['row_values', 'artifact_links', 'idempotency_receipt'],
  async execute(client, proposal, context) {
    const writer = repositoryForClient?.(client) ?? repository;
    await writer.insertReconciliation({
      ...proposal,
      makerArtifactId: context.checkedProposalId,
      checkerArtifactId: context.checkedProposalId,
      unresolvedDiscrepancies: proposal.unresolvedDiscrepancies,
    });
    await writer.insertItems(proposal.reconciliationId, proposal.items as never);
    await writer.insertEvidenceLinks(proposal.reconciliationId, proposal.evidenceArtifactIds);
    return {
      committedRecords: [{ recordType: 'reconciliation', recordId: proposal.reconciliationId }],
      expectedState: JSON.parse(JSON.stringify(proposal)) as never,
    };
  },
  async readback(_client, proposal, receipt): Promise<DomainReadbackOutput> {
    const observed = await repository.readReconciliation(proposal.reconciliationId);
    const observedText = canonicalizeJson(observed as never);
    const expectedText = canonicalizeJson(receipt.expectedState as never);
    const matches = observedText === expectedText;
    const evidenceOk = typeof observed === 'object' && observed !== null
      && 'evidenceArtifactIds' in observed
      && Array.isArray(observed.evidenceArtifactIds)
      && observed.evidenceArtifactIds.length === proposal.evidenceArtifactIds.length;
    return {
      checks: [
        { kind: 'row_values', status: matches ? 'passed' : 'failed',
          ...(matches ? {} : { detailCode: 'reconciliation_exact' }) },
        { kind: 'artifact_links', status: evidenceOk ? 'passed' : 'failed',
          ...(evidenceOk ? {} : { detailCode: 'reconciliation_evidence' }) },
      ],
      mismatches: matches && evidenceOk ? [] : ['reconciliation_readback_mismatch'],
      observedState: JSON.parse(JSON.stringify(observed)) as never,
    };
  },
});

export const createClosePeriodHandler = (
  service: Pick<PeriodCloseService, 'close' | 'readClose'>,
  serviceForClient?: (client: PoolClient) => Pick<PeriodCloseService, 'close' | 'readClose'>,
): MutationCommandHandler<PeriodCloseProposalV1> => ({
  commandType: 'close_accounting_period',
  domainRole: 'accounting',
  inputSchema: PeriodCloseProposalSchemaV1,
  inputSchemaIdentity: { schemaName: 'period-close-proposal', schemaVersion: 1 },
  confirmation: 'optional',
  requiredReadbackChecks: ['row_values', 'artifact_links', 'idempotency_receipt'],
  execute: (client, proposal, context) => (serviceForClient?.(client) ?? service).close(client, proposal, context),
  readback: (client, proposal, receipt) => service.readClose(client, proposal, receipt),
});

export const createReopenPeriodHandler = (
  service: Pick<PeriodCloseService, 'reopen' | 'readReopen'>,
  serviceForClient?: (client: PoolClient) => Pick<PeriodCloseService, 'reopen' | 'readReopen'>,
): MutationCommandHandler<PeriodReopenProposalV1> => ({
  commandType: 'reopen_accounting_period',
  domainRole: 'accounting',
  inputSchema: PeriodReopenProposalSchemaV1,
  inputSchemaIdentity: { schemaName: 'period-reopen-proposal', schemaVersion: 1 },
  confirmation: 'required',
  requiredReadbackChecks: ['row_values', 'artifact_links', 'idempotency_receipt'],
  execute: (client, proposal, context) => (serviceForClient?.(client) ?? service).reopen(client, proposal, context as never),
  readback: (client, proposal, receipt) => service.readReopen(client, proposal, receipt),
});
