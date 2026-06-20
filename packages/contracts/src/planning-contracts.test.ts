import { describe, expect, it } from 'vitest';
import {
  ActivateBudgetProposalSchemaV1,
  ArchivePlanningRecordProposalSchemaV1,
  PlanningReadbackSchemaV1,
  UpdateObligationProposalSchemaV1,
  UpsertDebtPlanProposalSchemaV1,
  UpsertSavingsGoalProposalSchemaV1,
} from './index.js';

const householdId = 'hh_01JNZQ4A9B8C7D6E5F4G3H2J1K';
const accountId = '1';

describe('planning contracts', () => {
  it('accepts a self-hash-free activated budget proposal', () => {
    const parsed = ActivateBudgetProposalSchemaV1.parse({
      schemaName: 'activate-budget-proposal',
      schemaVersion: 1,
      householdId,
      scopeKey: 'household-monthly',
      name: 'June budget',
      validFrom: '2026-06-01',
      validTo: '2026-06-30',
      categories: [{ categoryKey: 'groceries', name: 'Groceries' }],
      allocations: [{
        categoryKey: 'groceries',
        periodStart: '2026-06-01',
        periodEnd: '2026-06-30',
        amount: { amount: '900.00', currency: 'USD' },
      }],
      mappings: [{ categoryKey: 'groceries', accountId, direction: 'expense', validFrom: '2026-06-01' }],
    });

    expect(parsed.allocations[0]?.amount.amount).toBe('900.00');
  });

  it('rejects planning proposals that carry artifact hashes inside payloads', () => {
    const parsed = ActivateBudgetProposalSchemaV1.safeParse({
      schemaName: 'activate-budget-proposal',
      schemaVersion: 1,
      householdId,
      scopeKey: 'household-monthly',
      name: 'June budget',
      validFrom: '2026-06-01',
      categories: [{ categoryKey: 'groceries', name: 'Groceries' }],
      allocations: [],
      mappings: [],
      checkedProposalHash: 'a'.repeat(64),
    });

    expect(parsed.success).toBe(false);
  });

  it('validates obligation edit scope and occurrence dates', () => {
    expect(UpdateObligationProposalSchemaV1.parse({
      schemaName: 'update-obligation-proposal',
      schemaVersion: 1,
      householdId,
      obligationKey: 'rent',
      variant: 'bill',
      name: 'Rent',
      lifecycleStatus: 'active',
      recurrence: { frequency: 'monthly', interval: 1, timezone: 'America/New_York' },
      expectedAmount: { amount: '2500.00', currency: 'USD' },
      dueDay: 1,
      editScope: 'this_and_future',
      occurrences: [{
        occurrenceDate: '2026-07-01',
        dueDate: '2026-07-01',
        expectedAmount: { amount: '2500.00', currency: 'USD' },
      }],
    }).editScope).toBe('this_and_future');
  });

  it('accepts savings goals with virtual allocation buckets', () => {
    expect(UpsertSavingsGoalProposalSchemaV1.parse({
      schemaName: 'upsert-savings-goal-proposal',
      schemaVersion: 1,
      householdId,
      goalKey: 'emergency-fund',
      name: 'Emergency fund',
      target: { amount: '20000.00', currency: 'USD' },
      targetDate: '2027-01-01',
      assetAccountIds: [accountId],
      virtualAllocations: [{ accountId, allocationKey: 'emergency-cash', amount: { amount: '5000.00', currency: 'USD' } }],
    }).virtualAllocations).toHaveLength(1);
  });

  it('accepts debt plans with loan agreement terms', () => {
    expect(UpsertDebtPlanProposalSchemaV1.parse({
      schemaName: 'upsert-debt-plan-proposal',
      schemaVersion: 1,
      householdId,
      debtPlanKey: 'student-loan',
      liabilityAccountId: accountId,
      name: 'Student loan payoff',
      loanAgreement: {
        lenderName: 'Loan Co',
        principal: { amount: '12000.00', currency: 'USD' },
        annualInterestRate: '0.0525',
        effectiveFrom: '2026-06-01',
        paymentSchedule: { frequency: 'monthly', interval: 1, timezone: 'America/New_York' },
      },
      strategy: { monthlyPayment: { amount: '400.00', currency: 'USD' }, priority: 1 },
    }).loanAgreement.lenderName).toBe('Loan Co');
  });

  it('accepts archival commands for scoped planning records only', () => {
    expect(ArchivePlanningRecordProposalSchemaV1.parse({
      schemaName: 'archive-planning-record-proposal',
      schemaVersion: 1,
      householdId,
      recordType: 'obligation',
      recordKey: 'rent',
      archivedAt: '2026-06-19T00:00:00.000Z',
    }).recordType).toBe('obligation');
  });

  it('requires read-back to identify row values and audit records', () => {
    expect(PlanningReadbackSchemaV1.parse({
      schemaName: 'planning-readback',
      schemaVersion: 1,
      householdId,
      recordType: 'budget_version',
      recordId: '1',
      auditRecordId: '2',
      archivedAt: null,
    }).auditRecordId).toBe('2');
  });
});
