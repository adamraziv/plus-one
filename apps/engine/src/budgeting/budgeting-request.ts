import {
  BudgetingDelegateRequestSchemaV1,
  BudgetingKnownInputsSchemaV1,
  type BudgetingDelegateRequestV1,
  type BudgetingKnownInputsV1,
} from '@plus-one/planning';
import type { InboundChannelMessageV1 } from '@plus-one/contracts';

/**
 * Preserve the typed request selected by the orchestrator. Natural-language
 * interpretation belongs to the model contract and the budgeting team; this
 * boundary only verifies the shape and any evidence the model supplied.
 */
export function canonicalBudgetingDraft(
  message: InboundChannelMessageV1,
  request: BudgetingDelegateRequestV1,
): BudgetingDelegateRequestV1 {
  const parsed = BudgetingDelegateRequestSchemaV1.parse(request);
  const known = parsed.request.known;
  if (!hasBudgetFacts(known)) return parsed;
  if (
    known.evidence !== undefined
    && (
      budgetingEvidenceIsGrounded(message, known)
      || budgetingEvidenceIsContainedInInstruction(parsed.request.instruction, known)
    )
    && budgetingEvidenceCoversKnownFacts(known)
  ) return parsed;
  return BudgetingDelegateRequestSchemaV1.parse({
    ...parsed,
    request: {
      ...parsed.request,
      known: stripUngroundedBudgetFacts(),
    },
  });
}

export function budgetingEvidenceIsGrounded(
  message: InboundChannelMessageV1,
  known: BudgetingKnownInputsV1,
): boolean {
  return (known.evidence ?? []).every((span) =>
    span.end <= message.body.length
    && message.body.slice(span.start, span.end) === span.sourceQuote,
  );
}

function budgetingEvidenceIsContainedInInstruction(
  instruction: string,
  known: BudgetingKnownInputsV1,
): boolean {
  const normalizedInstruction = normalizedEvidenceText(instruction);
  return (known.evidence ?? []).every((span) =>
    normalizedInstruction.includes(normalizedEvidenceText(span.sourceQuote)),
  );
}

function normalizedEvidenceText(value: string): string {
  const expanded = value.toLocaleLowerCase().replace(
    /\b(\d+(?:\.\d+)?)\s*k\b/g,
    (_match: string, numberText: string) => String(Number(numberText) * 1_000),
  );
  return expanded
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .replaceAll(/(?<=\d) +(?=\d)/g, '')
    .trim();
}

export function budgetingEvidenceCoversKnownFacts(known: BudgetingKnownInputsV1): boolean {
  const evidence = known.evidence ?? [];
  return requiredBudgetEvidencePaths(known).every((requiredPath) =>
    evidence.some((span) => evidencePathCovers(requiredPath, span.path)),
  );
}

function requiredBudgetEvidencePaths(known: BudgetingKnownInputsV1): string[] {
  return [
    ...(known.priorities?.map((_priority, index) => `priorities[${index}]`) ?? []),
    ...(known.timeframe === undefined ? [] : ['timeframe.start', 'timeframe.end']),
    ...(known.targetAmount === undefined ? [] : ['targetAmount']),
    ...(known.categories?.map((_category, index) => `categories[${index}]`) ?? []),
  ];
}

function evidencePathCovers(requiredPath: string, evidencePath: string): boolean {
  return evidencePath === requiredPath
    || requiredPath.startsWith(`${evidencePath}.`)
    || requiredPath.startsWith(`${evidencePath}[`)
    || evidencePath.startsWith(`${requiredPath}.`)
    || evidencePath.startsWith(`${requiredPath}[`);
}

function hasBudgetFacts(known: BudgetingKnownInputsV1): boolean {
  return known.priorities !== undefined
    || known.timeframe !== undefined
    || known.targetAmount !== undefined
    || known.categories !== undefined;
}

function stripUngroundedBudgetFacts(): BudgetingKnownInputsV1 {
  return BudgetingKnownInputsSchemaV1.parse({});
}
