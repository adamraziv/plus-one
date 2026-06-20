import { z } from 'zod';
import { DatabaseIdSchema, HouseholdIdSchema } from './ids.js';
import { MoneySchemaV1 } from './money.js';
import { IanaTimezoneSchema, LocalDateSchema, UtcInstantSchema } from './time.js';

const strict = <Shape extends z.ZodRawShape>(shape: Shape) => z.object(shape).strict();
const key = z.string().min(1).max(80);
const name = z.string().min(1).max(160);

export const PlanningRecurrenceSchemaV1 = strict({
  frequency: z.enum(['weekly', 'monthly', 'yearly']),
  interval: z.number().int().positive(),
  timezone: IanaTimezoneSchema,
});

export const BudgetCategoryProposalSchemaV1 = strict({
  categoryKey: key,
  parentCategoryKey: key.optional(),
  name,
});

export const BudgetAllocationProposalSchemaV1 = strict({
  categoryKey: key,
  periodStart: LocalDateSchema,
  periodEnd: LocalDateSchema,
  amount: MoneySchemaV1,
});

export const BudgetMappingProposalSchemaV1 = strict({
  categoryKey: key,
  accountId: DatabaseIdSchema,
  direction: z.enum(['income', 'expense', 'transfer']),
  validFrom: LocalDateSchema,
  validTo: LocalDateSchema.optional(),
});

export const ActivateBudgetProposalSchemaV1 = strict({
  schemaName: z.literal('activate-budget-proposal'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  scopeKey: key,
  name,
  validFrom: LocalDateSchema,
  validTo: LocalDateSchema.optional(),
  categories: z.array(BudgetCategoryProposalSchemaV1).min(1),
  allocations: z.array(BudgetAllocationProposalSchemaV1),
  mappings: z.array(BudgetMappingProposalSchemaV1),
});
export type ActivateBudgetProposalV1 = z.infer<typeof ActivateBudgetProposalSchemaV1>;

export const ObligationOccurrenceProposalSchemaV1 = strict({
  occurrenceDate: LocalDateSchema,
  dueDate: LocalDateSchema,
  expectedAmount: MoneySchemaV1,
});

export const UpdateObligationProposalSchemaV1 = strict({
  schemaName: z.literal('update-obligation-proposal'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  obligationKey: key,
  variant: z.enum(['bill', 'subscription']),
  name,
  lifecycleStatus: z.enum(['active', 'paused', 'ended']),
  recurrence: PlanningRecurrenceSchemaV1,
  expectedAmount: MoneySchemaV1,
  dueDay: z.number().int().min(1).max(31),
  counterpartyName: name.optional(),
  accountId: DatabaseIdSchema.optional(),
  budgetCategoryKey: key.optional(),
  editScope: z.enum(['one_occurrence', 'this_and_future']),
  occurrences: z.array(ObligationOccurrenceProposalSchemaV1),
});
export type UpdateObligationProposalV1 = z.infer<typeof UpdateObligationProposalSchemaV1>;

export const VirtualAllocationProposalSchemaV1 = strict({
  accountId: DatabaseIdSchema,
  allocationKey: key,
  amount: MoneySchemaV1,
});

export const UpsertSavingsGoalProposalSchemaV1 = strict({
  schemaName: z.literal('upsert-savings-goal-proposal'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  goalKey: key,
  name,
  target: MoneySchemaV1,
  targetDate: LocalDateSchema.optional(),
  assetAccountIds: z.array(DatabaseIdSchema).min(1),
  budgetCategoryKey: key.optional(),
  virtualAllocations: z.array(VirtualAllocationProposalSchemaV1),
});
export type UpsertSavingsGoalProposalV1 = z.infer<typeof UpsertSavingsGoalProposalSchemaV1>;

export const LoanAgreementProposalSchemaV1 = strict({
  lenderName: name,
  principal: MoneySchemaV1,
  annualInterestRate: z.string().regex(/^\d+(\.\d{1,8})?$/),
  effectiveFrom: LocalDateSchema,
  paymentSchedule: PlanningRecurrenceSchemaV1,
});

export const DebtPlanStrategySchemaV1 = strict({
  monthlyPayment: MoneySchemaV1,
  priority: z.number().int().positive(),
});

export const UpsertDebtPlanProposalSchemaV1 = strict({
  schemaName: z.literal('upsert-debt-plan-proposal'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  debtPlanKey: key,
  liabilityAccountId: DatabaseIdSchema,
  name,
  budgetCategoryKey: key.optional(),
  loanAgreement: LoanAgreementProposalSchemaV1,
  strategy: DebtPlanStrategySchemaV1,
});
export type UpsertDebtPlanProposalV1 = z.infer<typeof UpsertDebtPlanProposalSchemaV1>;

export const ArchivePlanningRecordProposalSchemaV1 = strict({
  schemaName: z.literal('archive-planning-record-proposal'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  recordType: z.enum(['budget_scope', 'budget_category', 'obligation', 'savings_goal', 'debt_plan']),
  recordKey: key,
  archivedAt: UtcInstantSchema,
});
export type ArchivePlanningRecordProposalV1 = z.infer<typeof ArchivePlanningRecordProposalSchemaV1>;

export const PlanningReadbackSchemaV1 = strict({
  schemaName: z.literal('planning-readback'),
  schemaVersion: z.literal(1),
  householdId: HouseholdIdSchema,
  recordType: z.string().min(1),
  recordId: DatabaseIdSchema,
  auditRecordId: DatabaseIdSchema,
  archivedAt: UtcInstantSchema.nullable(),
});
export type PlanningReadbackV1 = z.infer<typeof PlanningReadbackSchemaV1>;
