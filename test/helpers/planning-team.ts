import { vi } from 'vitest';
import {
  PlanningCommandHandlers,
} from '@plus-one/planning';
import type { JsonValue } from '@plus-one/contracts';
import { PostgresVerificationLedgerRepository } from '@plus-one/database';
import { CheckedMutationWorkCellCoordinator } from '@plus-one/mutations';
import {
  canonicalizeJson,
  hashArtifact,
  type CheckedWorkCellResult,
} from '@plus-one/runtime';
import { Pool } from 'pg';
import { id } from './accounting-ledger.js';
import { createExecutor } from './checked-mutation.js';
import type { PostgresTestContext } from './postgres.js';

export interface PlanningTeamFixture {
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

export async function seedPlanningTeamFixture(owner: Pool, suffix = 72): Promise<{
  planning: PlanningTeamFixture;
}> {
  const householdId = id('hh', suffix);
  const household = await owner.query<{ id: string }>(
    `INSERT INTO operations.households (household_id, reporting_currency, reporting_timezone)
     VALUES ($1, 'USD', 'UTC') RETURNING id::text`,
    [householdId],
  );
  const householdDbId = household.rows[0]!.id;
  const book = await owner.query<{ id: string }>(
    `INSERT INTO accounting.books (book_id, household_id, name)
     VALUES ($1, $2, 'Planning Book') RETURNING id::text`,
    [id('book', suffix), householdDbId],
  );
  await owner.query(
    `INSERT INTO accounting.book_configurations
     (configuration_id, household_id, book_id, reporting_currency, effective_from)
     VALUES ($1,$2,$3,'USD',DATE '2026-01-01')`,
    [id('bookconfig', suffix), householdDbId, book.rows[0]!.id],
  );
  const account = async (name: string, accountingClass: string, normalBalance: string, offset: number) => {
    const result = await owner.query<{ id: string }>(
      `INSERT INTO accounting.accounts
       (account_id, household_id, book_id, name, accounting_class, normal_balance, native_currency)
       VALUES ($1,$2,$3,$4,$5,$6,'USD') RETURNING id::text`,
      [id('account', suffix * 10 + offset), householdDbId, book.rows[0]!.id, name, accountingClass, normalBalance],
    );
    return result.rows[0]!.id;
  };
  return {
    planning: {
      householdId,
      householdDbId,
      assetAccountId: await account('Savings', 'asset', 'debit', 1),
      expenseAccountId: await account('Food', 'expense', 'debit', 2),
      liabilityAccountId: await account('Loan', 'liability', 'credit', 3),
      context: {
        householdId,
        taskId: id('task', suffix),
        commandId: id('command', suffix),
        checkedProposalId: id('artifact', suffix * 2 - 1),
        checkedProposalHash: 'a'.repeat(64),
        idempotencyKey: id('idem', suffix),
      },
    },
  };
}

export interface SeededCheckedPlanningResult extends CheckedWorkCellResult {
  householdDbId: string;
}

export function checkedPlanningResult(input: {
  householdId: string;
  householdDbId: string;
  taskId: string;
  team: 'budgeting' | 'cash-flow';
  workCellId: string;
  outputSchema: { schemaName: string; schemaVersion: number };
  output: JsonValue;
  claimId: string;
  claimText: string;
}): SeededCheckedPlanningResult {
  const taskOrdinal = Number.parseInt(input.taskId.split('_')[1] ?? '0', 10);
  const artifactId = id('artifact', taskOrdinal * 2 - 1);
  const maker = {
    schemaName: 'maker-artifact' as const,
    schemaVersion: 1 as const,
    outputSchema: input.outputSchema,
    output: input.output,
    claims: [{ claimId: input.claimId, text: input.claimText, evidenceArtifactIds: [] }],
    assumptions: [],
    uncertainty: [],
  };
  const artifactHash = hashArtifact(maker);
  return {
    householdId: input.householdId,
    householdDbId: input.householdDbId,
    taskId: input.taskId,
    team: input.team,
    workCellId: input.workCellId,
    status: 'verified',
    completionState: 'checked_mutation_pending',
    makerArtifacts: [{
      artifactId,
      householdId: input.householdId,
      taskId: input.taskId,
      artifactType: 'maker_output',
      schema: { schemaName: 'maker-artifact', schemaVersion: 1 },
      canonicalizationVersion: 'rfc8785-v1',
      hashAlgorithm: 'sha256',
      artifactHash,
      payload: maker,
      createdAt: '2026-06-22T10:00:00.000Z',
    }],
    checkerVerdicts: [{
      verdict: 'accepted',
      coveredArtifactId: artifactId,
      coveredArtifactHash: artifactHash,
      findings: [],
    }],
    acceptedMaker: maker,
    completionReason: 'accepted',
    outstanding: [],
  } as unknown as SeededCheckedPlanningResult;
}

async function persistCheckedPlanningResult(owner: Pool, checked: SeededCheckedPlanningResult): Promise<void> {
  const makerArtifact = checked.makerArtifacts.at(-1);
  const verdict = checked.checkerVerdicts.at(-1);
  if (makerArtifact === undefined || verdict === undefined) throw new Error('checked result is incomplete');
  const checkerArtifactId = makerArtifact.artifactId.replace(/(\d+)$/, (digits) => String(Number.parseInt(digits, 10) + 1).padStart(digits.length, '0'));
  const checkerPayload = {
    verdict: 'accepted' as const,
    coveredArtifactId: makerArtifact.artifactId,
    coveredArtifactHash: makerArtifact.artifactHash,
    findings: [],
  };
  const checkerHash = hashArtifact(checkerPayload);
  await owner.query(
    `INSERT INTO operations.verification_tasks
     (task_id, household_id, team, status, attempt_limit, resumable)
     VALUES ($1,$2,$3,'checker_validated',2,false)`,
    [checked.taskId, checked.householdDbId, checked.team],
  );
  await owner.query(
    `INSERT INTO operations.artifacts
     (artifact_id, household_id, task_id, artifact_type, schema_name, schema_version,
      canonicalization_version, hash_algorithm, artifact_hash, canonical_payload, payload)
     VALUES
     ($1,$2,$3,'maker_output','maker-artifact',1,'rfc8785-v1','sha256',$4,$5,$6::jsonb),
     ($7,$2,$3,'checker_output','checker-verdict',1,'rfc8785-v1','sha256',$8,$9,$10::jsonb)`,
    [makerArtifact.artifactId, checked.householdDbId, checked.taskId,
      makerArtifact.artifactHash, canonicalizeJson(makerArtifact.payload), JSON.stringify(makerArtifact.payload),
      checkerArtifactId, checkerHash, canonicalizeJson(checkerPayload), JSON.stringify(checkerPayload)],
  );
  await owner.query(
    `INSERT INTO operations.checker_verdicts
     (household_id, task_id, checker_artifact_id, covered_artifact_id, covered_artifact_hash, verdict)
     VALUES ($1,$2,$3,$4,$5,'accepted')`,
    [checked.householdDbId, checked.taskId, checkerArtifactId, makerArtifact.artifactId, makerArtifact.artifactHash],
  );
  await owner.query(
    `UPDATE operations.verification_tasks
     SET current_maker_artifact_id = $3, current_maker_artifact_hash = $4
     WHERE household_id = $1 AND task_id = $2`,
    [checked.householdDbId, checked.taskId, makerArtifact.artifactId, makerArtifact.artifactHash],
  );
}

export async function createPlanningMutationCoordinator(
  owner: Pool,
  context: PostgresTestContext,
  checked: SeededCheckedPlanningResult,
) {
  await persistCheckedPlanningResult(owner, checked);
  const harness = createExecutor(context, PlanningCommandHandlers, 'planning');
  const operations = new Pool({ connectionString: context.roleUrls.operations });
  const coordinator = new CheckedMutationWorkCellCoordinator({
    teamExecutor: { executeWorkCell: vi.fn().mockResolvedValue(checked) } as never,
    mutationExecutor: harness.executor as never,
    runtime: { complete: vi.fn().mockResolvedValue({ status: 'verified' }) } as never,
    ledger: new PostgresVerificationLedgerRepository(operations) as never,
  });
  return {
    coordinator,
    close: async () => {
      await harness.close();
      await operations.end();
    },
  };
}
