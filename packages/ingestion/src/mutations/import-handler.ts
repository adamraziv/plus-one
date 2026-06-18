import { JournalDraftInputSchemaV1, PostJournalInputSchemaV1 } from '@plus-one/contracts';
import type { JournalDraftRepository, JournalPostingService } from '@plus-one/accounting';
import type { DomainReadbackOutput, MutationCommandHandler } from '@plus-one/mutations';
import { canonicalizeJson } from '@plus-one/runtime';
import {
  ConfirmImportBatchProposalSchemaV1,
  type ConfirmImportBatchProposalV1,
} from '../contracts.js';
import type { IngestionRepository } from '../repositories/ingestion-repository.js';

export function createConfirmImportBatchHandler(dependencies: {
  repository: Pick<IngestionRepository,
    'lockBatch' | 'transitionBatch' | 'insertRowDecision' | 'linkJournalSource' | 'readBatchOutcome'>;
  repositoryForClient?: (client: Parameters<JournalPostingService['postInTransaction']>[0]) => Pick<IngestionRepository,
    'lockBatch' | 'transitionBatch' | 'insertRowDecision' | 'linkJournalSource' | 'readBatchOutcome'>;
  drafts: Pick<JournalDraftRepository, 'insertVersion'>;
  posting: Pick<JournalPostingService, 'postInTransaction'>;
}): MutationCommandHandler<ConfirmImportBatchProposalV1> {
  return {
    commandType: 'confirm_import_batch',
    domainRole: 'accounting',
    inputSchema: ConfirmImportBatchProposalSchemaV1,
    inputSchemaIdentity: { schemaName: 'confirm-import-batch-proposal', schemaVersion: 1 },
    confirmation: 'required',
    requiredReadbackChecks: ['source_links', 'artifact_links', 'idempotency_receipt'],
    async execute(client, proposal, context) {
      const repository = dependencies.repositoryForClient?.(client) ?? dependencies.repository;
      const batch = await repository.lockBatch(proposal.importBatchId);
      if (batch?.state !== 'awaiting_confirmation' || batch.batchVersion !== proposal.batchVersion) {
        throw new Error('Import proposal does not match locked batch');
      }
      await repository.transitionBatch(proposal.importBatchId, 'awaiting_confirmation', 'approved');
      await repository.transitionBatch(proposal.importBatchId, 'approved', 'posting');
      const committedRecords: Array<{ recordType: string; recordId: string }> = [];

      for (const decision of proposal.decisions) {
        await repository.insertRowDecision({
          importBatchId: proposal.importBatchId,
          normalizedRowId: decision.normalizedRowId,
          checkedArtifactId: context.checkedProposalId,
          checkedArtifactHash: context.checkedProposalHash,
          action: decision.action,
          ...(decision.action === 'link_existing' ? { targetJournalId: decision.existingJournalId } : {}),
          reasonCode: decision.reasonCode,
        });

        if (decision.action === 'post') {
          await dependencies.drafts.insertVersion(client, JournalDraftInputSchemaV1.parse({
            schemaName: 'journal-draft-input',
            schemaVersion: 1,
            householdId: decision.draft.journal.householdId,
            bookId: decision.draft.journal.bookId,
            draftId: decision.draft.journal.draftId,
            draftSeriesId: decision.draft.draftSeriesId,
            version: decision.draft.version,
            taskId: decision.draft.journal.taskId,
            checkedArtifactId: context.checkedProposalId,
            checkedArtifactHash: context.checkedProposalHash,
            journalType: decision.draft.journal.journalType,
            transactionCurrency: decision.draft.journal.transactionCurrency,
            occurredOn: decision.draft.journal.occurredOn,
            effectiveOn: decision.draft.journal.effectiveOn,
            ...(decision.draft.journal.settlementOn === undefined ? {} : {
              settlementOn: decision.draft.journal.settlementOn,
            }),
            ...(decision.draft.journal.sourceOn === undefined ? {} : {
              sourceOn: decision.draft.journal.sourceOn,
            }),
            description: decision.draft.journal.description,
            ...(decision.draft.journal.counterpartyId === undefined ? {} : {
              counterpartyId: decision.draft.journal.counterpartyId,
            }),
            tagIds: decision.draft.journal.tagIds,
            postings: decision.draft.journal.postings,
          }));
          const journal = PostJournalInputSchemaV1.parse({
            ...decision.draft.journal,
            schemaName: 'post-journal-input',
            checkedArtifactId: context.checkedProposalId,
            checkedArtifactHash: context.checkedProposalHash,
          });
          const posted = await dependencies.posting.postInTransaction(client, journal);
          await repository.linkJournalSource({
            journalId: posted.journalId,
            normalizedRowId: decision.normalizedRowId,
            linkKind: 'import_posted',
            checkedArtifactId: context.checkedProposalId,
          });
          committedRecords.push({ recordType: 'journal', recordId: posted.journalId });
        } else if (decision.action === 'link_existing') {
          await repository.linkJournalSource({
            journalId: decision.existingJournalId,
            normalizedRowId: decision.normalizedRowId,
            linkKind: 'matched_existing',
            checkedArtifactId: context.checkedProposalId,
          });
        }
      }

      const terminal = proposal.decisions.every((entry) =>
        entry.action === 'post' || entry.action === 'link_existing')
        ? 'posted'
        : 'partially_posted';
      await repository.transitionBatch(proposal.importBatchId, 'posting', terminal);
      committedRecords.push({ recordType: 'import_batch', recordId: proposal.importBatchId });
      return {
        committedRecords,
        expectedState: {
          importBatchId: proposal.importBatchId,
          state: terminal,
          decisions: proposal.decisions.map(({ normalizedRowId, action }) => ({ normalizedRowId, action })),
          allRowsBoundToCheckedArtifact: true,
        },
      };
    },
    async readback(_client, proposal, receipt): Promise<DomainReadbackOutput> {
      const observed = await dependencies.repository.readBatchOutcome(proposal.importBatchId);
      const observedText = canonicalizeJson(observed as never);
      const expectedText = canonicalizeJson(receipt.expectedState as never);
      const artifactOk = typeof observed === 'object' && observed !== null
        && 'allRowsBoundToCheckedArtifact' in observed
        && observed.allRowsBoundToCheckedArtifact === true;
      const matches = observedText === expectedText;
      return {
        checks: [
          { kind: 'source_links', status: matches ? 'passed' : 'failed',
            ...(matches ? {} : { detailCode: 'import_batch_outcome' }) },
          { kind: 'artifact_links', status: artifactOk ? 'passed' : 'failed',
            ...(artifactOk ? {} : { detailCode: 'import_checked_provenance' }) },
        ],
        mismatches: matches && artifactOk ? [] : ['import_batch_readback_mismatch'],
        observedState: JSON.parse(JSON.stringify(observed)) as never,
      };
    },
  };
}
