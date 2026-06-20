import { PlanningReadbackSchemaV1, type PlanningReadbackV1, type UpdateObligationProposalV1 } from '@plus-one/contracts';
import type { MutationExecutionContext } from '@plus-one/mutations';
import type { PoolClient } from 'pg';

async function householdDbId(client: PoolClient, householdId: string) {
  const result = await client.query<{ id: string }>('SELECT id::text FROM operations.households WHERE household_id = $1', [householdId]);
  if (result.rows[0] === undefined) throw new Error('Household was not found');
  return result.rows[0].id;
}

async function categoryId(client: PoolClient, householdId: string, key: string | undefined) {
  if (key === undefined) return null;
  const result = await client.query<{ id: string }>(
    'SELECT id::text FROM planning.budget_categories WHERE household_id = $1 AND category_key = $2 AND archived_at IS NULL',
    [householdId, key],
  );
  return result.rows[0]?.id ?? null;
}

async function audit(client: PoolClient, householdId: string, id: string, context: MutationExecutionContext, payload: unknown) {
  const result = await client.query<{ id: string }>(
    `INSERT INTO planning.domain_audit_records
     (household_id, entity_table, entity_id, action, command_id, checked_proposal_id, checked_proposal_hash, payload)
     VALUES ($1,'planning.recurring_obligations',$2,'updated',$3,$4,$5,$6::jsonb) RETURNING id::text`,
    [householdId, id, context.commandId, context.checkedProposalId, context.checkedProposalHash, JSON.stringify(payload)],
  );
  return result.rows[0]!.id;
}

export class ObligationRepository {
  async upsert(client: PoolClient, input: UpdateObligationProposalV1, context: MutationExecutionContext): Promise<PlanningReadbackV1> {
    const householdId = await householdDbId(client, input.householdId);
    const obligation = await client.query<{ id: string }>(
      `INSERT INTO planning.recurring_obligations
       (household_id, obligation_key, variant, name, lifecycle_status, recurrence, expected_amount,
        expected_currency, due_day, counterparty_name, account_id, budget_category_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (household_id, obligation_key) WHERE archived_at IS NULL
       DO UPDATE SET variant = EXCLUDED.variant, name = EXCLUDED.name, lifecycle_status = EXCLUDED.lifecycle_status,
         recurrence = EXCLUDED.recurrence, expected_amount = EXCLUDED.expected_amount,
         expected_currency = EXCLUDED.expected_currency, due_day = EXCLUDED.due_day,
         counterparty_name = EXCLUDED.counterparty_name, account_id = EXCLUDED.account_id,
         budget_category_id = EXCLUDED.budget_category_id
       RETURNING id::text`,
      [householdId, input.obligationKey, input.variant, input.name, input.lifecycleStatus,
        JSON.stringify(input.recurrence), input.expectedAmount.amount, input.expectedAmount.currency, input.dueDay,
        input.counterpartyName ?? null, input.accountId ?? null, await categoryId(client, householdId, input.budgetCategoryKey)],
    );
    for (const occurrence of input.occurrences) {
      await client.query(
        `INSERT INTO planning.obligation_occurrences
         (household_id, obligation_id, occurrence_date, due_date, expected_amount, expected_currency)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (household_id, obligation_id, occurrence_date)
         DO UPDATE SET due_date = EXCLUDED.due_date, expected_amount = EXCLUDED.expected_amount,
           expected_currency = EXCLUDED.expected_currency`,
        [householdId, obligation.rows[0]!.id, occurrence.occurrenceDate, occurrence.dueDate,
          occurrence.expectedAmount.amount, occurrence.expectedAmount.currency],
      );
    }
    return PlanningReadbackSchemaV1.parse({
      schemaName: 'planning-readback',
      schemaVersion: 1,
      householdId: input.householdId,
      recordType: 'obligation',
      recordId: obligation.rows[0]!.id,
      auditRecordId: await audit(client, householdId, obligation.rows[0]!.id, context, input),
      archivedAt: null,
    });
  }
}
