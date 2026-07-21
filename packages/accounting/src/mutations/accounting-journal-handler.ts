import type { PoolClient } from 'pg';
import { z } from 'zod';
import type {
  DomainReadbackOutput, MutationCommandHandler,
} from '@plus-one/mutations';
import {
  CurrencyCodeSchema, DecimalStringSchema, JournalDraftInputSchemaV1,
  PlusOneError, PostJournalInputSchemaV1, ReverseAndReplaceInputSchemaV1,
  type JournalDraftInputV1, type PostJournalInputV1,
} from '@plus-one/contracts';
import { ProjectionWriter } from '@plus-one/reporting';
import { CorrectionService } from '../posting/corrections.js';
import { JournalPostingService } from '../posting/journal-posting-service.js';
import { JournalDraftRepository } from '../repositories/journal-draft-repository.js';
import { LedgerReadback } from '../repositories/ledger-readback.js';
import {
  AccountingClarificationSchemaV1,
  AccountingJournalMutationProposalSchemaV1,
  AccountingWorkResultSchemaV1,
  type AccountingWorkResultV1,
  type CheckedJournalDraftProposalV1,
} from '../team/contracts.js';

const JournalExpectedStateSchema = z.object({
  journals: z.array(PostJournalInputSchemaV1).min(1).max(2),
  balances: z.array(z.object({
    accountId: z.string().min(1),
    currency: CurrencyCodeSchema,
    amount: DecimalStringSchema,
  }).strict()),
}).strict();

const bindDraft = (draft: CheckedJournalDraftProposalV1, context: {
  checkedProposalId: string; checkedProposalHash: string;
}): { journal: PostJournalInputV1; draftInput: JournalDraftInputV1 } => {
  const { postings, ...journalBody } = draft.journal;
  const journal = PostJournalInputSchemaV1.parse({
    ...journalBody,
    schemaName: 'post-journal-input' as const, schemaVersion: 1 as const,
    checkedArtifactId: context.checkedProposalId,
    checkedArtifactHash: context.checkedProposalHash,
    postings: [...postings],
  });
  const { periodId: _periodId, reversesJournalId: _rev, replacesJournalId: _rep,
    journalId: _journalId, ...draftBody } = journalBody;
  void _periodId; void _rev; void _rep; void _journalId;
  const draftInput = JournalDraftInputSchemaV1.parse({
    ...draftBody,
    schemaName: 'journal-draft-input' as const, schemaVersion: 1 as const,
    taskId: journalBody.taskId,
    draftId: draft.journal.draftId,
    draftSeriesId: draft.draftSeriesId, version: draft.version,
    ...(draft.previousDraftId === undefined ? {} : { previousDraftId: draft.previousDraftId }),
    checkedArtifactId: context.checkedProposalId,
    checkedArtifactHash: context.checkedProposalHash,
    postings: [...postings],
  });
  return { journal, draftInput };
};

export function createAccountingJournalMutationHandler(dependencies: {
  drafts?: Pick<JournalDraftRepository, 'insertVersion'>;
  posting?: Pick<JournalPostingService, 'postInTransaction'>;
  corrections?: Pick<CorrectionService, 'reverseAndReplaceInTransaction'>;
  readback?: Pick<LedgerReadback, 'verifyPostedJournal' | 'accountNativeBalance'>;
} = {}): MutationCommandHandler<AccountingWorkResultV1> {
  const drafts = dependencies.drafts ?? new JournalDraftRepository();
  const posting = dependencies.posting ?? new JournalPostingService(new ProjectionWriter());
  const corrections = dependencies.corrections ?? new CorrectionService(posting);
  const readback = dependencies.readback ?? new LedgerReadback();

  return {
    commandType: 'apply_accounting_journal_mutation',
    domainRole: 'accounting',
    inputSchema: AccountingWorkResultSchemaV1,
    inputSchemaIdentity: { schemaName: 'accounting-journal-mutation-proposal', schemaVersion: 1 },
    confirmation: 'optional',
    requiredReadbackChecks: [
      'identifiers', 'row_values', 'balances', 'artifact_links', 'idempotency_receipt',
    ],
    async execute(client: PoolClient, candidate: AccountingWorkResultV1, context) {
      const parsed: AccountingWorkResultV1 = AccountingWorkResultSchemaV1.parse(candidate);
      if (AccountingClarificationSchemaV1.safeParse(parsed).success) {
        throw new PlusOneError({
          category: 'validation_rejected',
          code: 'accounting_clarification_not_executable',
          message: 'A clarification result cannot become a mutation command',
          retry: 'never',
          receiptLookupRequired: false,
          details: {},
        });
      }
      const proposal = AccountingJournalMutationProposalSchemaV1.parse(parsed);
      const bound = proposal.operation === 'post'
        ? [bindDraft(proposal.draft, context)]
        : [bindDraft(proposal.reversal, context), bindDraft(proposal.replacement, context)];
      for (const item of bound) await drafts.insertVersion(client, item.draftInput);
      const posted = proposal.operation === 'post'
        ? [await posting.postInTransaction(client, bound[0]!.journal)]
        : await (async () => {
          const out = await corrections.reverseAndReplaceInTransaction(client,
            ReverseAndReplaceInputSchemaV1.parse({
              originalJournalId: proposal.originalJournalId,
              reversal: bound[0]!.journal, replacement: bound[1]!.journal,
            }));
          return [out.reversal, out.replacement];
        })();
      const journals = bound.map((item) => item.journal);
      const accountIds: string[] = [...new Set(journals.flatMap((journal) =>
        journal.postings.map((entry) => String(entry.accountId))))].sort();
      const balances: Array<{ accountId: string; currency: string; amount: string }> = [];
      for (const accountId of accountIds) {
        const result = await readback.accountNativeBalance(client, {
          householdId: journals[0]!.householdId, accountId,
          asOf: journals.map((entry) => entry.effectiveOn).sort().at(-1)!,
        });
        balances.push({ accountId, currency: result.currency, amount: result.amount });
      }
      const expectedState = JSON.parse(JSON.stringify(JournalExpectedStateSchema.parse({
        journals: journals.map((journal) => PostJournalInputSchemaV1.parse({
          ...journal, journalId: String(journal.journalId),
        })),
        balances,
      })));
      const committedRecords = posted.flatMap((entry) => [
        { recordType: 'accounting.journal', recordId: entry.journalId },
        ...entry.postingIds.map((recordId) => ({ recordType: 'accounting.posting', recordId })),
      ]);
      return { committedRecords, expectedState };
    },
    async readback(client, _input, receipt): Promise<DomainReadbackOutput> {
      const expected = JournalExpectedStateSchema.parse(receipt.expectedState);
      const mismatches: string[] = [];
      for (const journal of expected.journals) {
        const result = await readback.verifyPostedJournal(client, {
          householdId: journal.householdId, expected: journal,
        });
        mismatches.push(...result.mismatches.map((entry) => journal.journalId + '.' + entry));
      }
      for (const balance of expected.balances) {
        const observed = await readback.accountNativeBalance(client, {
          householdId: expected.journals[0]!.householdId, accountId: balance.accountId,
          asOf: expected.journals.map((entry) => entry.effectiveOn).sort().at(-1)!,
        });
        if (observed.currency !== balance.currency || observed.amount !== balance.amount) {
          mismatches.push('balance.' + balance.accountId);
        }
      }
      const artifactMismatch = mismatches.some((entry) =>
        entry.endsWith('.checked_artifact_id') || entry.endsWith('.checked_artifact_hash'));
      const identifierMismatch = mismatches.some((entry) =>
        entry.endsWith('.journal_missing') || entry.endsWith('.posting_id'));
      const balanceMismatch = mismatches.some((entry) => entry.startsWith('balance.'));
      const rowMismatch = mismatches.some((entry) => !entry.startsWith('balance.')
        && !entry.endsWith('.journal_missing') && !entry.endsWith('.posting_id')
        && !entry.endsWith('.checked_artifact_id') && !entry.endsWith('.checked_artifact_hash'));
      return {
        checks: [
          { kind: 'identifiers', status: identifierMismatch ? 'failed' : 'passed',
            ...(identifierMismatch ? { detailCode: 'journal_identifier_mismatch' } : {}) },
          { kind: 'row_values', status: rowMismatch ? 'failed' : 'passed',
            ...(rowMismatch ? { detailCode: 'journal_row_mismatch' } : {}) },
          { kind: 'balances', status: balanceMismatch ? 'failed' : 'passed',
            ...(balanceMismatch ? { detailCode: 'balance_mismatch' } : {}) },
          { kind: 'source_links', status: 'not_applicable' },
          { kind: 'artifact_links', status: artifactMismatch ? 'failed' : 'passed',
            ...(artifactMismatch ? { detailCode: 'artifact_link_mismatch' } : {}) },
        ],
        mismatches,
        observedState: { journalCount: expected.journals.length, mismatches },
      };
    },
  };
}
