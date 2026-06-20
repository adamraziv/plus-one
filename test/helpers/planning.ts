import type { Pool } from 'pg';
import { id } from './accounting-ledger.js';

export interface PlanningFixture {
  householdId: string;
  householdDbId: string;
  assetAccountId: string;
  expenseAccountId: string;
  liabilityAccountId: string;
  context: {
    householdId: string;
    taskId: string;
    commandId: string;
    checkedProposalId: string;
    checkedProposalHash: string;
    idempotencyKey: string;
  };
}

export async function seedPlanningHousehold(pool: Pool, householdId = id('hh', 5)): Promise<PlanningFixture> {
  const household = await pool.query<{ id: string }>(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1, 'USD', 'UTC') RETURNING id::text`,
    [householdId],
  );
  const householdDbId = household.rows[0]!.id;
  const book = await pool.query<{ id: string }>(
    `INSERT INTO accounting.books (book_id, household_id, name)
     VALUES ($1, $2, 'Planning Book') RETURNING id::text`,
    [id('book', 5), householdDbId],
  );
  await pool.query(
    `INSERT INTO accounting.book_configurations
     (configuration_id, household_id, book_id, reporting_currency, effective_from)
     VALUES ($1,$2,$3,'USD',DATE '2026-01-01')`,
    [id('bookconfig', 5), householdDbId, book.rows[0]!.id],
  );
  const account = async (suffix: number, name: string, accountingClass: string, normalBalance: string) => {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO accounting.accounts
       (account_id, household_id, book_id, name, accounting_class, normal_balance, native_currency)
       VALUES ($1,$2,$3,$4,$5,$6,'USD') RETURNING id::text`,
      [id('account', suffix), householdDbId, book.rows[0]!.id, name, accountingClass, normalBalance],
    );
    return result.rows[0]!.id;
  };

  return {
    householdId,
    householdDbId,
    assetAccountId: await account(51, 'Savings', 'asset', 'debit'),
    expenseAccountId: await account(52, 'Food', 'expense', 'debit'),
    liabilityAccountId: await account(53, 'Loan', 'liability', 'credit'),
    context: {
      householdId,
      taskId: id('task', 5),
      commandId: id('command', 5),
      checkedProposalId: id('artifact', 5),
      checkedProposalHash: 'a'.repeat(64),
      idempotencyKey: id('idem', 5),
    },
  };
}
