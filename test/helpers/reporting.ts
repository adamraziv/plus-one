import { JournalPostingService, AccountingJournalMutationProposalSchemaV1 } from '@plus-one/accounting';
import type { CurrentBalanceProjectionHook } from '@plus-one/accounting';
import type { Pool } from 'pg';
import { canonicalizeJson, hashArtifact } from '@plus-one/runtime';
import { id } from './accounting-ledger.js';

export async function seedPostedJournalInput(owner: Pool) {
  const householdId = id('hh', 90);
  const bookId = id('book', 90);
  const taskId = id('task', 90);
  const artifactId = id('artifact', 179);
  const checkerArtifactId = id('artifact', 180);
  const cashAccountId = id('account', 90);
  const foodAccountId = id('account', 91);
  const household = await owner.query<{ id: string }>(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1,'USD','UTC') RETURNING id::text`,
    [householdId],
  );
  const householdDbId = household.rows[0]!.id;
  const book = await owner.query<{ id: string }>(
    `INSERT INTO accounting.books (book_id, household_id, name)
     VALUES ($1,$2,'Household Book') RETURNING id::text`,
    [bookId, householdDbId],
  );
  const bookDbId = book.rows[0]!.id;
  await owner.query(
    `INSERT INTO accounting.book_configurations
     (configuration_id, household_id, book_id, reporting_currency, effective_from)
     VALUES ($1,$2,$3,'USD',DATE '2026-01-01')`,
    [id('bookconfig', 90), householdDbId, bookDbId],
  );
  await owner.query(
    `INSERT INTO accounting.periods
     (period_id, household_id, book_id, period_start, period_end)
     VALUES ($1,$2,$3,DATE '2026-06-01',DATE '2026-06-30')`,
    [id('period', 90), householdDbId, bookDbId],
  );
  const cash = await owner.query<{ id: string }>(
    `INSERT INTO accounting.accounts
     (account_id, household_id, book_id, name, accounting_class, normal_balance, native_currency)
     VALUES ($1,$2,$3,'Cash','asset','debit','USD') RETURNING id::text`,
    [cashAccountId, householdDbId, bookDbId],
  );
  await owner.query(
    `INSERT INTO accounting.accounts
     (account_id, household_id, book_id, name, accounting_class, normal_balance, native_currency)
     VALUES ($1,$2,$3,'Food','expense','debit','USD')`,
    [foodAccountId, householdDbId, bookDbId],
  );

  const workResult = AccountingJournalMutationProposalSchemaV1.parse({
    schemaName: 'accounting-journal-mutation-proposal',
    schemaVersion: 1,
    operation: 'post',
    draft: {
      draftSeriesId: id('draftseries', 90),
      version: 1,
      journal: {
        schemaName: 'post-journal-proposal',
        schemaVersion: 1,
        householdId,
        bookId,
        journalId: id('journal', 90),
        draftId: id('draft', 90),
        periodId: id('period', 90),
        taskId,
        journalType: 'ordinary',
        transactionCurrency: 'USD',
        occurredOn: '2026-06-20',
        effectiveOn: '2026-06-20',
        description: 'Groceries',
        tagIds: [],
        postings: [
          { accountId: cashAccountId, direction: 'credit', transactionAmount: '20.00',
            accountNativeAmount: '20.00', accountNativeCurrency: 'USD', tagIds: [] },
          { accountId: foodAccountId, direction: 'debit', transactionAmount: '20.00',
            accountNativeAmount: '20.00', accountNativeCurrency: 'USD', tagIds: [] },
        ],
      },
    },
  });
  const makerPayload = {
    schemaName: 'maker-artifact' as const,
    schemaVersion: 1 as const,
    outputSchema: { schemaName: 'accounting-work-result', schemaVersion: 1 },
    output: JSON.parse(JSON.stringify(workResult)),
    claims: [],
    assumptions: [],
    uncertainty: [],
  };
  const artifactHash = hashArtifact(makerPayload);
  const checkerPayload = {
    verdict: 'accepted' as const,
    coveredArtifactId: artifactId,
    coveredArtifactHash: artifactHash,
    findings: [],
  };
  await owner.query(
    `INSERT INTO operations.verification_tasks
     (task_id, household_id, team, status, attempt_limit, resumable)
     VALUES ($1,$2,'accounting','checker_validated',2,false)`,
    [taskId, householdDbId],
  );
  await owner.query(
    `INSERT INTO operations.artifacts
     (artifact_id, household_id, task_id, artifact_type, schema_name, schema_version,
      canonicalization_version, hash_algorithm, artifact_hash, canonical_payload, payload)
     VALUES
     ($1,$2,$3,'maker_output','maker-artifact',1,'rfc8785-v1','sha256',$4,$5,$6),
     ($7,$2,$3,'checker_output','checker-verdict',1,'rfc8785-v1','sha256',$8,$9,$10)`,
    [artifactId, householdDbId, taskId, artifactHash, canonicalizeJson(makerPayload), makerPayload,
      checkerArtifactId, hashArtifact(checkerPayload), canonicalizeJson(checkerPayload), checkerPayload],
  );
  await owner.query(
    `INSERT INTO operations.checker_verdicts
     (household_id, task_id, checker_artifact_id, covered_artifact_id, covered_artifact_hash, verdict)
     VALUES ($1,$2,$3,$4,$5,'accepted')`,
    [householdDbId, taskId, checkerArtifactId, artifactId, artifactHash],
  );
  await owner.query(
    `UPDATE operations.verification_tasks
     SET current_maker_artifact_id=$3, current_maker_artifact_hash=$4
     WHERE household_id=$1 AND task_id=$2`,
    [householdDbId, taskId, artifactId, artifactHash],
  );

  return {
    householdId,
    householdDbId,
    cashAccountDbId: cash.rows[0]!.id,
    postingService: (projection: CurrentBalanceProjectionHook) => new JournalPostingService(projection),
    commandContext: {
      householdId,
      taskId,
      commandId: id('command', 90),
      checkedProposalId: artifactId,
      checkedProposalHash: artifactHash,
      idempotencyKey: id('idem', 90),
    },
    workResult,
  };
}
