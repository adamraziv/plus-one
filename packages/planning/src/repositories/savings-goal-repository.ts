import { PlanningReadbackSchemaV1, type PlanningReadbackV1, type UpsertSavingsGoalProposalV1 } from '@plus-one/contracts';
import type { MutationExecutionContext } from '@plus-one/mutations';
import type { PoolClient } from 'pg';

async function householdDbId(client: PoolClient, householdId: string) {
  const result = await client.query<{ id: string }>('SELECT id::text FROM operations.households WHERE household_id = $1', [householdId]);
  if (result.rows[0] === undefined) throw new Error('Household was not found');
  return result.rows[0].id;
}

async function audit(client: PoolClient, householdId: string, id: string, context: MutationExecutionContext, payload: unknown) {
  const result = await client.query<{ id: string }>(
    `INSERT INTO planning.domain_audit_records
     (household_id, entity_table, entity_id, action, command_id, checked_proposal_id, checked_proposal_hash, payload)
     VALUES ($1,'planning.savings_goals',$2,'updated',$3,$4,$5,$6::jsonb) RETURNING id::text`,
    [householdId, id, context.commandId, context.checkedProposalId, context.checkedProposalHash, JSON.stringify(payload)],
  );
  return result.rows[0]!.id;
}

export class SavingsGoalRepository {
  async upsert(client: PoolClient, input: UpsertSavingsGoalProposalV1, context: MutationExecutionContext): Promise<PlanningReadbackV1> {
    const householdId = await householdDbId(client, input.householdId);
    const goal = await client.query<{ id: string }>(
      `INSERT INTO planning.savings_goals
       (household_id, goal_key, name, target_amount, target_currency, target_date)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (household_id, goal_key) WHERE archived_at IS NULL
       DO UPDATE SET name = EXCLUDED.name, target_amount = EXCLUDED.target_amount,
         target_currency = EXCLUDED.target_currency, target_date = EXCLUDED.target_date
       RETURNING id::text`,
      [householdId, input.goalKey, input.name, input.target.amount, input.target.currency, input.targetDate ?? null],
    );
    for (const accountId of input.assetAccountIds) {
      await client.query(
        `INSERT INTO planning.savings_goal_accounts(household_id, goal_id, account_id)
         VALUES ($1,$2,$3)
         ON CONFLICT (household_id, goal_id, account_id) WHERE archived_at IS NULL DO NOTHING`,
        [householdId, goal.rows[0]!.id, accountId],
      );
    }
    for (const allocation of input.virtualAllocations) {
      await client.query(
        `INSERT INTO planning.virtual_allocations(household_id, goal_id, account_id, allocation_key, amount, currency)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (household_id, account_id, allocation_key) WHERE archived_at IS NULL
         DO UPDATE SET goal_id = EXCLUDED.goal_id, amount = EXCLUDED.amount, currency = EXCLUDED.currency`,
        [householdId, goal.rows[0]!.id, allocation.accountId, allocation.allocationKey, allocation.amount.amount, allocation.amount.currency],
      );
    }
    return PlanningReadbackSchemaV1.parse({
      schemaName: 'planning-readback',
      schemaVersion: 1,
      householdId: input.householdId,
      recordType: 'savings_goal',
      recordId: goal.rows[0]!.id,
      auditRecordId: await audit(client, householdId, goal.rows[0]!.id, context, input),
      archivedAt: null,
    });
  }
}
