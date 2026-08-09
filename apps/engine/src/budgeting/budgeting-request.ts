import {
  BudgetingDelegateRequestSchemaV1,
  BudgetingKnownInputsSchemaV1,
  type BudgetingDelegateRequestV1,
  type BudgetingKnownInputsV1,
} from '@plus-one/planning';
import type { InboundChannelMessageV1 } from '@plus-one/contracts';
import {
  budgetingContinuationIsCompatible,
  budgetingKnownInputs,
  type BudgetingContinuationV1,
} from './budgeting-continuation.js';

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

export function prepareBudgetingDraft(
  message: InboundChannelMessageV1,
  request: BudgetingDelegateRequestV1,
  continuation?: BudgetingContinuationV1,
): BudgetingDelegateRequestV1 {
  const parsed = BudgetingDelegateRequestSchemaV1.parse(request);
  if (continuation === undefined || !budgetingContinuationIsCompatible(continuation, parsed)) {
    return canonicalBudgetingDraft(message, parsed);
  }

  const retained = budgetingKnownInputs(continuation);
  const current = parsed.request.known;
  const changedPaths = changedBudgetFactPaths(current, retained);
  if (changedPaths.length === 0) return requestWithKnown(parsed, retained);

  const candidateEvidence = (current.evidence ?? []).filter((span) =>
    changedPaths.some((path) => evidencePathCovers(path, span.path)),
  );
  const candidateIsGrounded = budgetingEvidenceIsGroundedForSpans(message, candidateEvidence)
    || budgetingEvidenceIsContainedInInstructionForSpans(parsed.request.instruction, candidateEvidence);
  const candidateIsCovered = budgetingEvidenceCoversPaths(candidateEvidence, changedPaths);
  if (!candidateIsGrounded || !candidateIsCovered) return requestWithKnown(parsed, retained);

  return requestWithKnown(parsed, mergeBudgetFacts(retained, current));
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

export function budgetingEvidenceCoversPaths(
  evidence: BudgetingKnownInputsV1['evidence'],
  requiredPaths: readonly string[],
): boolean {
  return requiredPaths.every((requiredPath) =>
    (evidence ?? []).some((span) => evidencePathCovers(requiredPath, span.path)),
  );
}

function requiredBudgetEvidencePaths(known: BudgetingKnownInputsV1): string[] {
  return [
    ...(known.priorities?.map((_priority, index) => `priorities[${index}]`) ?? []),
    ...(known.timeframe === undefined
      ? []
      : [
          'timeframe.start',
          ...(known.timeframe.end === undefined ? [] : ['timeframe.end']),
        ]),
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

function changedBudgetFactPaths(
  current: BudgetingKnownInputsV1,
  retained: BudgetingKnownInputsV1,
): string[] {
  const paths: string[] = [];
  if (current.priorities !== undefined) {
    if (retained.priorities === undefined) {
      paths.push(...current.priorities.map((_priority, index) => `priorities[${index}]`));
    } else {
      current.priorities.forEach((priority, index) => {
        if (retained.priorities?.[index] !== priority) paths.push(`priorities[${index}]`);
      });
    }
  }
  if (current.timeframe !== undefined) {
    if (retained.timeframe === undefined || retained.timeframe.start !== current.timeframe.start) {
      paths.push('timeframe.start');
    }
    if (
      current.timeframe.end !== undefined
      && (retained.timeframe === undefined || retained.timeframe.end !== current.timeframe.end)
    ) {
      paths.push('timeframe.end');
    }
  }
  if (current.targetAmount !== undefined && !moneyEqual(current.targetAmount, retained.targetAmount)) {
    paths.push('targetAmount');
  }
  if (current.categories !== undefined) {
    if (retained.categories === undefined) {
      paths.push(...current.categories.map((_category, index) => `categories[${index}]`));
    } else {
      current.categories.forEach((category, index) => {
        const previous = retained.categories?.[index];
        if (!categoryEqual(category, previous)) paths.push(`categories[${index}]`);
      });
    }
  }
  return paths;
}

function mergeBudgetFacts(
  retained: BudgetingKnownInputsV1,
  current: BudgetingKnownInputsV1,
): BudgetingKnownInputsV1 {
  return BudgetingKnownInputsSchemaV1.parse({
    ...(retained.priorities === undefined && current.priorities === undefined
      ? {}
      : { priorities: mergeIndexedValues(retained.priorities, current.priorities) }),
    ...(current.timeframe === undefined
      ? (retained.timeframe === undefined ? {} : { timeframe: retained.timeframe })
      : {
          timeframe: {
            ...retained.timeframe,
            ...current.timeframe,
          },
        }),
    ...(current.targetAmount === undefined
      ? (retained.targetAmount === undefined ? {} : { targetAmount: retained.targetAmount })
      : { targetAmount: current.targetAmount }),
    ...(retained.categories === undefined && current.categories === undefined
      ? {}
      : { categories: mergeCategories(retained.categories, current.categories) }),
  });
}

function mergeIndexedValues<T>(
  retained: readonly T[] | undefined,
  current: readonly T[] | undefined,
): T[] | undefined {
  if (retained === undefined && current === undefined) return undefined;
  const length = Math.max(retained?.length ?? 0, current?.length ?? 0);
  return Array.from({ length }, (_value, index) => current?.[index] ?? retained?.[index])
    .filter((value): value is T => value !== undefined);
}

function mergeCategories(
  retained: BudgetingKnownInputsV1['categories'],
  current: BudgetingKnownInputsV1['categories'],
): BudgetingKnownInputsV1['categories'] | undefined {
  if (retained === undefined) return current;
  if (current === undefined) return retained;
  const length = Math.max(retained.length, current.length);
  return Array.from({ length }, (_value, index) => {
    const previous = retained[index];
    const next = current[index];
    if (previous === undefined) return next;
    if (next === undefined) return previous;
    return {
      ...previous,
      ...next,
      ...(next.targetAmount === undefined ? {} : { targetAmount: next.targetAmount }),
    };
  }).filter((category): category is NonNullable<typeof category> => category !== undefined);
}

function moneyEqual(
  left: BudgetingKnownInputsV1['targetAmount'],
  right: BudgetingKnownInputsV1['targetAmount'],
): boolean {
  return left?.amount === right?.amount && left?.currency === right?.currency;
}

function categoryEqual(
  left: NonNullable<BudgetingKnownInputsV1['categories']>[number],
  right: NonNullable<BudgetingKnownInputsV1['categories']>[number] | undefined,
): boolean {
  if (right === undefined || left.name !== right.name) return false;
  return left.targetAmount === undefined || moneyEqual(left.targetAmount, right.targetAmount);
}

function requestWithKnown(
  request: BudgetingDelegateRequestV1,
  known: BudgetingKnownInputsV1,
): BudgetingDelegateRequestV1 {
  return BudgetingDelegateRequestSchemaV1.parse({
    ...request,
    request: {
      ...request.request,
      known: BudgetingKnownInputsSchemaV1.parse(known),
    },
  });
}

function budgetingEvidenceIsGroundedForSpans(
  message: InboundChannelMessageV1,
  spans: NonNullable<BudgetingKnownInputsV1['evidence']>,
): boolean {
  return spans.every((span) =>
    span.end <= message.body.length
    && message.body.slice(span.start, span.end) === span.sourceQuote,
  );
}

function budgetingEvidenceIsContainedInInstructionForSpans(
  instruction: string,
  spans: NonNullable<BudgetingKnownInputsV1['evidence']>,
): boolean {
  const normalizedInstruction = normalizedEvidenceText(instruction);
  return spans.every((span) =>
    normalizedInstruction.includes(normalizedEvidenceText(span.sourceQuote)),
  );
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
