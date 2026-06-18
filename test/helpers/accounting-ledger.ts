// test/helpers/accounting-ledger.ts
import { PostJournalInputSchemaV1, type PostJournalInputV1 } from '@plus-one/contracts';
import type { Pool } from 'pg';

export interface DraftSpec {
  index: number;
  journalType: PostJournalInputV1['journalType'];
  description: string;
  transactionCurrency: string;
  reversesIndex?: number;
  replacesIndex?: number;
  postings: Array<Omit<PostJournalInputV1['postings'][number], 'postingId'>>;
}

export const householdId = id('hh', 1);
export const bookId = id('book', 1);
export const periodId = id('period', 1);
export const accounts = {
  cash: id('account', 1),
  savings: id('account', 2),
  food: id('account', 3),
  euroBank: id('account', 4),
  fxGain: id('account', 5),
  fxLoss: id('account', 6),
} as const;

export function id(prefix: string, value: number): string {
  return prefix + '_' + String(value).padStart(26, '0');
}

export function artifactHash(index: number): string {
  return (index % 16).toString(16).repeat(64);
}

export function postInput(spec: DraftSpec): PostJournalInputV1 {
  return PostJournalInputSchemaV1.parse({
    schemaName: 'post-journal-input', schemaVersion: 1,
    householdId, bookId, journalId: id('journal', spec.index),
    draftId: id('draft', spec.index), periodId, taskId: id('task', spec.index),
    checkedArtifactId: id('artifact', spec.index * 2 - 1),
    checkedArtifactHash: artifactHash(spec.index),
    journalType: spec.journalType, transactionCurrency: spec.transactionCurrency,
    occurredOn: '2026-06-15', effectiveOn: '2026-06-15',
    description: spec.description, tagIds: [],
    ...(spec.reversesIndex === undefined ? {} : { reversesJournalId: id('journal', spec.reversesIndex) }),
    ...(spec.replacesIndex === undefined ? {} : { replacesJournalId: id('journal', spec.replacesIndex) }),
    postings: spec.postings.map((posting, offset) => ({
      ...posting, postingId: id('posting', spec.index * 10 + offset + 1),
    })),
  });
}

export async function seedLedgerScenario(owner: Pool, drafts: readonly DraftSpec[]): Promise<void> {
  const household = await owner.query<{ id: string }>(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1, 'USD', 'UTC') RETURNING id::text`, [householdId],
  );
  const householdDbId = household.rows[0]!.id;
  const book = await owner.query<{ id: string }>(
    `INSERT INTO accounting.books (book_id, household_id, name)
     VALUES ($1, $2, 'Household Book') RETURNING id::text`, [bookId, householdDbId],
  );
  const bookDbId = book.rows[0]!.id;
  await owner.query(
    `INSERT INTO accounting.book_configurations
     (configuration_id, household_id, book_id, reporting_currency, effective_from)
     VALUES ($1,$2,$3,'USD',DATE '2026-01-01')`,
    [id('bookconfig', 1), householdDbId, bookDbId],
  );
  const period = await owner.query<{ id: string }>(
    `INSERT INTO accounting.periods
     (period_id, household_id, book_id, period_start, period_end)
     VALUES ($1,$2,$3,DATE '2026-06-01',DATE '2026-06-30') RETURNING id::text`,
    [periodId, householdDbId, bookDbId],
  );
  const accountRows = [
    [accounts.cash, 'Cash', 'asset', 'debit', 'USD'],
    [accounts.savings, 'Savings', 'asset', 'debit', 'USD'],
    [accounts.food, 'Food', 'expense', 'debit', 'USD'],
    [accounts.euroBank, 'Euro Bank', 'asset', 'debit', 'EUR'],
    [accounts.fxGain, 'Realized FX Gain', 'income', 'credit', 'USD'],
    [accounts.fxLoss, 'Realized FX Loss', 'expense', 'debit', 'USD'],
  ] as const;
  const accountIds = new Map<string, string>();
  for (const row of accountRows) {
    const inserted = await owner.query<{ id: string }>(
      `INSERT INTO accounting.accounts
       (account_id, household_id, book_id, name, accounting_class, normal_balance, native_currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`,
      [row[0], householdDbId, bookDbId, row[1], row[2], row[3], row[4]],
    );
    accountIds.set(row[0], inserted.rows[0]!.id);
  }

  for (const spec of drafts) {
    const taskId = id('task', spec.index);
    const makerId = id('artifact', spec.index * 2 - 1);
    const checkerId = id('artifact', spec.index * 2);
    const hash = artifactHash(spec.index);
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
       ($1,$2,$3,'maker_output','journal-draft-input',1,'rfc8785-v1','sha256',$4,'{}','{}'),
       ($5,$2,$3,'checker_output','checker-verdict',1,'rfc8785-v1','sha256',$6,'{}','{}')`,
      [makerId, householdDbId, taskId, hash, checkerId, artifactHash(spec.index + 8)],
    );
    await owner.query(
      `INSERT INTO operations.checker_verdicts
       (household_id, task_id, checker_artifact_id, covered_artifact_id, covered_artifact_hash, verdict)
       VALUES ($1,$2,$3,$4,$5,'accepted')`,
      [householdDbId, taskId, checkerId, makerId, hash],
    );
    const draft = await owner.query<{ id: string }>(
      `INSERT INTO accounting.journal_drafts
       (draft_id, draft_series_id, version, household_id, book_id, task_id,
        checked_artifact_id, checked_artifact_hash, journal_type, transaction_currency,
        occurred_on, effective_on, description, tag_ids)
       VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,DATE '2026-06-15',
         DATE '2026-06-15',$10,'{}') RETURNING id::text`,
      [id('draft', spec.index), id('draftseries', spec.index), householdDbId, bookDbId,
        taskId, makerId, hash, spec.journalType, spec.transactionCurrency, spec.description],
    );
    for (const [offset, posting] of spec.postings.entries()) {
      await owner.query(
        `INSERT INTO accounting.draft_postings
         (household_id, draft_id, ordinal, account_id, direction, transaction_amount,
          account_native_amount, account_native_currency, exchange_rate,
          exchange_rate_quote, exchange_rate_date, exchange_rate_source, memo, tag_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'{}')`,
        [householdDbId, draft.rows[0]!.id, offset + 1, accountIds.get(posting.accountId),
          posting.direction, posting.transactionAmount, posting.accountNativeAmount,
          posting.accountNativeCurrency, posting.exchangeRate ?? null,
          posting.exchangeRateQuote ?? null, posting.exchangeRateDate ?? null,
          posting.exchangeRateSource ?? null, posting.memo ?? null],
      );
    }
  }
  if (!period.rows[0]?.id) throw new Error('Period insert failed');
}
