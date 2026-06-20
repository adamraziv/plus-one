import { PlanningReadbackSchemaV1, type PlanningReadbackV1, type UpsertDebtPlanProposalV1 } from '@plus-one/contracts';
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
     VALUES ($1,'planning.debt_plans',$2,'updated',$3,$4,$5,$6::jsonb) RETURNING id::text`,
    [householdId, id, context.commandId, context.checkedProposalId, context.checkedProposalHash, JSON.stringify(payload)],
  );
  return result.rows[0]!.id;
}

export class DebtPlanRepository {
  async upsert(client: PoolClient, input: UpsertDebtPlanProposalV1, context: MutationExecutionContext): Promise<PlanningReadbackV1> {
    const householdId = await householdDbId(client, input.householdId);
    const loan = await client.query<{ id: string }>(
      `INSERT INTO planning.loan_agreements
       (household_id, liability_account_id, lender_name, principal_amount, principal_currency,
        annual_interest_rate, effective_from, payment_schedule)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id::text`,
      [householdId, input.liabilityAccountId, input.loanAgreement.lenderName,
        input.loanAgreement.principal.amount, input.loanAgreement.principal.currency,
        input.loanAgreement.annualInterestRate, input.loanAgreement.effectiveFrom,
        JSON.stringify(input.loanAgreement.paymentSchedule)],
    );
    const plan = await client.query<{ id: string }>(
      `INSERT INTO planning.debt_plans
       (household_id, debt_plan_key, liability_account_id, loan_agreement_id, name,
        monthly_payment_amount, monthly_payment_currency, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (household_id, debt_plan_key) WHERE archived_at IS NULL
       DO UPDATE SET liability_account_id = EXCLUDED.liability_account_id,
         loan_agreement_id = EXCLUDED.loan_agreement_id, name = EXCLUDED.name,
         monthly_payment_amount = EXCLUDED.monthly_payment_amount,
         monthly_payment_currency = EXCLUDED.monthly_payment_currency, priority = EXCLUDED.priority
       RETURNING id::text`,
      [householdId, input.debtPlanKey, input.liabilityAccountId, loan.rows[0]!.id, input.name,
        input.strategy.monthlyPayment.amount, input.strategy.monthlyPayment.currency, input.strategy.priority],
    );
    return PlanningReadbackSchemaV1.parse({
      schemaName: 'planning-readback',
      schemaVersion: 1,
      householdId: input.householdId,
      recordType: 'debt_plan',
      recordId: plan.rows[0]!.id,
      auditRecordId: await audit(client, householdId, plan.rows[0]!.id, context, input),
      archivedAt: null,
    });
  }
}
