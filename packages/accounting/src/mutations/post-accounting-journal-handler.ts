import {
  CurrencyCodeSchema,
  DecimalStringSchema,
  PostJournalInputSchemaV1,
  PostJournalProposalSchemaV1,
  type JsonValue,
  type PostJournalProposalV1,
} from '@plus-one/contracts';
import type {
  DomainReadbackOutput,
  MutationCommandHandler,
  MutationExecutionOutput,
} from '@plus-one/mutations';
import { z } from 'zod';
import { JournalPostingService } from '../posting/journal-posting-service.js';
import type { CurrentBalanceProjectionHook } from '../posting/projection-hook.js';
import { LedgerReadback } from '../repositories/ledger-readback.js';

const BalanceSnapshotSchema = z.object({
  accountId: z.string().min(1),
  currency: CurrencyCodeSchema,
  amount: DecimalStringSchema,
}).strict();

const AccountingExpectedStateSchema = z.object({
  journal: PostJournalInputSchemaV1,
  balances: z.array(BalanceSnapshotSchema),
}).strict();
type AccountingExpectedState = z.infer<typeof AccountingExpectedStateSchema>;

export function createPostAccountingJournalHandler(
  projection?: CurrentBalanceProjectionHook,
): MutationCommandHandler<PostJournalProposalV1> {
  const posting = new JournalPostingService(projection);
  const readback = new LedgerReadback();
  return {
    commandType: 'post_accounting_journal',
    domainRole: 'accounting',
    inputSchema: PostJournalProposalSchemaV1,
    inputSchemaIdentity: { schemaName: 'post-journal-proposal', schemaVersion: 1 },
    confirmation: 'optional',
    requiredReadbackChecks: [
      'identifiers',
      'row_values',
      'balances',
      'artifact_links',
      'idempotency_receipt',
    ],
    async execute(client, input, context): Promise<MutationExecutionOutput> {
      const journal = PostJournalInputSchemaV1.parse({
        ...input,
        schemaName: 'post-journal-input',
        checkedArtifactId: context.checkedProposalId,
        checkedArtifactHash: context.checkedProposalHash,
      });
      const posted = await posting.postInTransaction(client, journal);
      const balances: AccountingExpectedState['balances'] = [];
      for (const accountId of [...new Set(input.postings.map((entry) => entry.accountId))].sort()) {
        balances.push(BalanceSnapshotSchema.parse({
          accountId,
          ...(await readback.accountNativeBalance(client, {
            householdId: input.householdId,
            accountId,
            asOf: input.effectiveOn,
          })),
        }));
      }
      const expected: AccountingExpectedState = { journal, balances };
      return {
        committedRecords: [
          { recordType: 'accounting.journal', recordId: posted.journalId },
          ...posted.postingIds.map((recordId) => ({ recordType: 'accounting.posting', recordId })),
        ],
        expectedState: JSON.parse(JSON.stringify(expected)) as JsonValue,
      };
    },
    async readback(client, input, receipt): Promise<DomainReadbackOutput> {
      const expected = AccountingExpectedStateSchema.parse(receipt.expectedState);
      const journal = await readback.verifyPostedJournal(client, {
        householdId: input.householdId,
        expected: expected.journal,
      });
      const balanceMismatches: string[] = [];
      for (const balance of expected.balances) {
        const observed = await readback.accountNativeBalance(client, {
          householdId: input.householdId,
          accountId: balance.accountId,
          asOf: input.effectiveOn,
        });
        if (observed.currency !== balance.currency || observed.amount !== balance.amount) {
          balanceMismatches.push('balances.' + balance.accountId);
        }
      }
      const identifierMismatch = journal.mismatches.includes('journal_missing')
        || journal.mismatches.some((mismatch) => mismatch.endsWith('.posting_id'));
      const artifactMismatch = journal.mismatches.some((mismatch) =>
        ['checked_artifact_id', 'checked_artifact_hash', 'task_id', 'draft_id'].includes(mismatch));
      const rowMismatches = journal.mismatches.filter((mismatch) =>
        mismatch !== 'journal_missing'
        && !mismatch.endsWith('.posting_id')
        && !['checked_artifact_id', 'checked_artifact_hash', 'task_id', 'draft_id'].includes(mismatch));

      return {
        checks: [
          {
            kind: 'identifiers',
            status: identifierMismatch ? 'failed' : 'passed',
            ...(identifierMismatch ? { detailCode: 'committed_identifier_mismatch' } : {}),
          },
          {
            kind: 'row_values',
            status: rowMismatches.length > 0 ? 'failed' : 'passed',
            ...(rowMismatches.length > 0 ? { detailCode: 'journal_row_mismatch' } : {}),
          },
          {
            kind: 'balances',
            status: balanceMismatches.length > 0 ? 'failed' : 'passed',
            ...(balanceMismatches.length > 0 ? { detailCode: 'account_balance_mismatch' } : {}),
          },
          { kind: 'source_links', status: 'not_applicable' },
          {
            kind: 'artifact_links',
            status: artifactMismatch ? 'failed' : 'passed',
            ...(artifactMismatch ? { detailCode: 'artifact_link_mismatch' } : {}),
          },
        ],
        mismatches: [...journal.mismatches, ...balanceMismatches],
        observedState: {
          journalId: input.journalId,
          journalMismatches: journal.mismatches,
          balanceMismatches,
        },
      };
    },
  };
}
