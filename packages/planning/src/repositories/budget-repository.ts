import { PlanningReadbackSchemaV1, type ActivateBudgetProposalV1, type PlanningReadbackV1 } from '@plus-one/contracts';
import type { MutationExecutionContext } from '@plus-one/mutations';
import type { PoolClient } from 'pg';

async function householdDbId(client: PoolClient, householdId: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    'SELECT id::text FROM operations.households WHERE household_id = $1',
    [householdId],
  );
  if (result.rows[0] === undefined) throw new Error('Household was not found');
  return result.rows[0].id;
}

async function audit(client: PoolClient, householdId: string, table: string, id: string, action: string, context: MutationExecutionContext, payload: unknown) {
  const result = await client.query<{ id: string }>(
    `INSERT INTO planning.domain_audit_records
     (household_id, entity_table, entity_id, action, command_id, checked_proposal_id, checked_proposal_hash, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id::text`,
    [householdId, table, id, action, context.commandId, context.checkedProposalId, context.checkedProposalHash, JSON.stringify(payload)],
  );
  return result.rows[0]!.id;
}

export class BudgetRepository {
  async activate(client: PoolClient, input: ActivateBudgetProposalV1, context: MutationExecutionContext): Promise<PlanningReadbackV1> {
    const householdId = await householdDbId(client, input.householdId);
    const scope = await client.query<{ id: string }>(
      `INSERT INTO planning.budget_scopes(household_id, scope_key, name)
       VALUES ($1,$2,$3)
       ON CONFLICT (household_id, scope_key) WHERE archived_at IS NULL
       DO UPDATE SET name = EXCLUDED.name
       RETURNING id::text`,
      [householdId, input.scopeKey, input.scopeKey],
    );
    const categoryIds = new Map<string, string>();
    for (const category of input.categories) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO planning.budget_categories(household_id, category_key, name)
         VALUES ($1,$2,$3)
         ON CONFLICT (household_id, category_key) WHERE archived_at IS NULL
         DO UPDATE SET name = EXCLUDED.name
         RETURNING id::text`,
        [householdId, category.categoryKey, category.name],
      );
      categoryIds.set(category.categoryKey, inserted.rows[0]!.id);
    }
    const version = await client.query<{ id: string }>(
      `INSERT INTO planning.budget_versions(household_id, scope_id, name, valid_from, valid_to)
       VALUES ($1,$2,$3,$4,$5) RETURNING id::text`,
      [householdId, scope.rows[0]!.id, input.name, input.validFrom, input.validTo ?? null],
    );
    for (const allocation of input.allocations) {
      await client.query(
        `INSERT INTO planning.budget_allocations
         (household_id, budget_version_id, category_id, period_start, period_end, amount, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [householdId, version.rows[0]!.id, categoryIds.get(allocation.categoryKey), allocation.periodStart,
          allocation.periodEnd, allocation.amount.amount, allocation.amount.currency],
      );
    }
    for (const mapping of input.mappings) {
      await client.query(
        `INSERT INTO planning.budget_category_account_mappings
         (household_id, category_id, account_id, direction, valid_from, valid_to)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [householdId, categoryIds.get(mapping.categoryKey), mapping.accountId, mapping.direction, mapping.validFrom, mapping.validTo ?? null],
      );
    }
    const auditRecordId = await audit(client, householdId, 'planning.budget_versions', version.rows[0]!.id, 'created', context, input);
    return PlanningReadbackSchemaV1.parse({
      schemaName: 'planning-readback',
      schemaVersion: 1,
      householdId: input.householdId,
      recordType: 'budget_version',
      recordId: version.rows[0]!.id,
      auditRecordId,
      archivedAt: null,
    });
  }
}
