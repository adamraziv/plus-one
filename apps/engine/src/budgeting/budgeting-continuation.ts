import { z } from 'zod';
import {
  BudgetingDelegateRequestSchemaV1,
  BudgetingKnownInputsSchemaV1,
  type BudgetingDelegateRequestV1,
  type BudgetingKnownInputsV1,
} from '@plus-one/planning';

const BudgetingKnownInputsWithoutEvidenceSchemaV1 = BudgetingKnownInputsSchemaV1.omit({
  evidence: true,
});

export type BudgetingKnownInputsWithoutEvidenceV1 = z.infer<
  typeof BudgetingKnownInputsWithoutEvidenceSchemaV1
>;

export const BudgetingContinuationSchemaV1 = z.discriminatedUnion('intent', [
  z.object({
    schemaName: z.literal('budgeting-continuation'),
    schemaVersion: z.literal(1),
    intent: z.literal('budget_plan'),
    requestSchemaName: z.literal('budget-plan-request-draft'),
    scopeKey: z.string().min(1).max(80),
    known: BudgetingKnownInputsWithoutEvidenceSchemaV1,
  }).strict(),
  z.object({
    schemaName: z.literal('budgeting-continuation'),
    schemaVersion: z.literal(1),
    intent: z.literal('budget_scenarios'),
    requestSchemaName: z.literal('budget-scenario-request-draft'),
    scenarioCount: z.number().int().min(2).max(3),
    known: BudgetingKnownInputsWithoutEvidenceSchemaV1,
  }).strict(),
]);

export type BudgetingContinuationV1 = z.infer<typeof BudgetingContinuationSchemaV1>;

export function budgetingContinuation(
  request: BudgetingDelegateRequestV1,
): BudgetingContinuationV1 {
  const parsed = BudgetingDelegateRequestSchemaV1.parse(request);
  const { evidence: _evidence, ...known } = parsed.request.known;
  return BudgetingContinuationSchemaV1.parse({
    schemaName: 'budgeting-continuation',
    schemaVersion: 1,
    intent: parsed.intent,
    requestSchemaName: parsed.request.schemaName,
    ...(parsed.intent === 'budget_plan'
      ? { scopeKey: parsed.request.scopeKey }
      : { scenarioCount: parsed.request.scenarioCount }),
    known: BudgetingKnownInputsWithoutEvidenceSchemaV1.parse(known),
  });
}

export function budgetingContinuationIsCompatible(
  continuation: BudgetingContinuationV1,
  request: BudgetingDelegateRequestV1,
): boolean {
  const parsed = BudgetingDelegateRequestSchemaV1.safeParse(request);
  if (!parsed.success || parsed.data.intent !== continuation.intent) return false;
  if (parsed.data.request.schemaName !== continuation.requestSchemaName) return false;
  return 'scopeKey' in continuation
    ? parsed.data.intent === 'budget_plan' && parsed.data.request.scopeKey === continuation.scopeKey
    : parsed.data.intent === 'budget_scenarios'
      && parsed.data.request.scenarioCount === continuation.scenarioCount;
}

export function budgetingKnownInputs(
  continuation: BudgetingContinuationV1,
): BudgetingKnownInputsV1 {
  return BudgetingKnownInputsSchemaV1.parse(continuation.known);
}
