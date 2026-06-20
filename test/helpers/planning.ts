import {
  CheckedCommandSchemaV1,
  type CheckedCommandV1,
  type JsonValue,
} from '@plus-one/contracts';
import { canonicalizeJson, hashArtifact } from '@plus-one/runtime';
import type { ActivateBudgetCommandAdapter } from '@plus-one/planning';
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

export async function seedCheckedPlanningBudgetMutation(pool: Pool, adapter: ActivateBudgetCommandAdapter): Promise<{ command: CheckedCommandV1 }> {
  const fixture = await seedPlanningHousehold(pool, id('hh', 55));
  const payload = {
    schemaName: 'activate-budget-proposal' as const,
    schemaVersion: 1 as const,
    householdId: fixture.householdId,
    scopeKey: 'monthly',
    name: 'July budget',
    validFrom: '2026-07-01',
    categories: [{ categoryKey: 'food', name: 'Food' }],
    allocations: [{
      categoryKey: 'food',
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
      amount: { amount: '800.00', currency: 'USD' },
    }],
    mappings: [{ categoryKey: 'food', accountId: fixture.expenseAccountId, direction: 'expense' as const, validFrom: '2026-07-01' }],
  };
  const makerPayload = {
    schemaName: 'maker-artifact' as const,
    schemaVersion: 1 as const,
    outputSchema: { schemaName: 'activate-budget-proposal', schemaVersion: 1 },
    output: payload as JsonValue,
    claims: [{ claimId: 'budget-ready', text: 'Budget proposal is ready for checked execution.', evidenceArtifactIds: [] }],
    assumptions: [],
    uncertainty: [],
  } satisfies JsonValue;
  const proposalHash = hashArtifact(makerPayload);
  const checkerPayload = {
    verdict: 'accepted' as const,
    coveredArtifactId: fixture.context.checkedProposalId,
    coveredArtifactHash: proposalHash,
    findings: [],
  };
  const checkerHash = hashArtifact(checkerPayload);
  await pool.query(
    `INSERT INTO operations.verification_tasks
     (task_id, household_id, team, status, attempt_limit, resumable)
     VALUES ($1,$2,'budgeting','checker_validated',2,false)`,
    [fixture.context.taskId, fixture.householdDbId],
  );
  await pool.query(
    `INSERT INTO operations.artifacts
     (artifact_id, household_id, task_id, artifact_type, schema_name, schema_version,
      canonicalization_version, hash_algorithm, artifact_hash, canonical_payload, payload)
     VALUES
     ($1,$2,$3,'maker_output','maker-artifact',1,'rfc8785-v1','sha256',$4,$5,$6::jsonb),
     ($7,$2,$3,'checker_output','checker-verdict',1,'rfc8785-v1','sha256',$8,$9,$10::jsonb)`,
    [fixture.context.checkedProposalId, fixture.householdDbId, fixture.context.taskId,
      proposalHash, canonicalizeJson(makerPayload), JSON.stringify(makerPayload), id('artifact', 56),
      checkerHash, canonicalizeJson(checkerPayload), JSON.stringify(checkerPayload)],
  );
  await pool.query(
    `INSERT INTO operations.checker_verdicts
     (household_id, task_id, checker_artifact_id, covered_artifact_id, covered_artifact_hash, verdict)
     VALUES ($1,$2,$3,$4,$5,'accepted')`,
    [fixture.householdDbId, fixture.context.taskId, id('artifact', 56), fixture.context.checkedProposalId, proposalHash],
  );
  await pool.query(
    `UPDATE operations.verification_tasks
     SET current_maker_artifact_id = $3, current_maker_artifact_hash = $4
     WHERE household_id = $1 AND task_id = $2`,
    [fixture.householdDbId, fixture.context.taskId, fixture.context.checkedProposalId, proposalHash],
  );
  return {
    command: CheckedCommandSchemaV1.parse(adapter.buildCommand({
      ...fixture.context,
      checkedProposalHash: proposalHash,
      payloadSchema: { schemaName: 'activate-budget-proposal', schemaVersion: 1 },
      payload: payload as JsonValue,
    })),
  };
}
