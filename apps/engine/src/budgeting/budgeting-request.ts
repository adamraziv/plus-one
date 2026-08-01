import {
  BudgetingDelegateRequestSchemaV1,
  BudgetingKnownInputsSchemaV1,
  missingBudgetPlanFields,
  missingBudgetScenarioFields,
  type BudgetingDelegateRequestV1,
  type BudgetingKnownInputsV1,
} from '@plus-one/planning';
import type { InboundChannelMessageV1 } from '@plus-one/contracts';

/**
 * Canonicalize only facts that are present in the current user message.
 * A continuation may carry previously established typed facts, but any new
 * facts in the current message must still be recovered from its text.
 */
export function canonicalBudgetingDraft(
  message: InboundChannelMessageV1,
  request: BudgetingDelegateRequestV1,
): BudgetingDelegateRequestV1 {
  const known = request.request.known;
  const source = message.body.trim().toLocaleLowerCase();
  const continuation = /\b(?:create it|please create|set it up|go ahead|proceed|do it|confirm|yes)\b/.test(source);
  const canonicalKnown = continuation
    ? BudgetingKnownInputsSchemaV1.parse({
        ...known,
        ...inferredBudgetKnown(source),
      })
    : BudgetingKnownInputsSchemaV1.parse({
        ...groundedBudgetKnown(source, known),
        ...inferredBudgetKnown(source),
      });
  return BudgetingDelegateRequestSchemaV1.parse({
    ...request,
    request: { ...request.request, known: canonicalKnown },
  });
}

/**
 * Return a typed budgeting request only when the current message contains all
 * facts required to execute it. This is an orchestrator routing guard; it does
 * not invent evidence or identifiers and leaves incomplete requests to the
 * normal model/tool loop.
 */
export function budgetingExplicitRequestForMessage(
  message: InboundChannelMessageV1,
): BudgetingDelegateRequestV1 | undefined {
  const source = message.body.trim().toLocaleLowerCase();
  if (!/\bbudget\b/.test(source)) return undefined;
  const scenario = /\b(?:scenario|scenarios|compare|comparison|lean|buffered)\b/.test(source);
  const request = scenario
    ? BudgetingDelegateRequestSchemaV1.parse({
        schemaName: 'budgeting-lead-request',
        schemaVersion: 1,
        intent: 'budget_scenarios',
        request: {
          schemaName: 'budget-scenario-request-draft',
          schemaVersion: 1,
          instruction: message.body,
          scenarioCount: 2,
          known: {},
        },
      })
    : BudgetingDelegateRequestSchemaV1.parse({
        schemaName: 'budgeting-lead-request',
        schemaVersion: 1,
        intent: 'budget_plan',
        request: {
          schemaName: 'budget-plan-request-draft',
          schemaVersion: 1,
          instruction: message.body,
          scopeKey: 'monthly',
          known: {},
        },
      });
  const canonical = canonicalBudgetingDraft(message, request);
  const missing = canonical.intent === 'budget_plan'
    ? missingBudgetPlanFields(canonical.request.known)
    : missingBudgetScenarioFields(canonical.request.known);
  return missing.length === 0 ? canonical : undefined;
}

function groundedBudgetKnown(
  source: string,
  known: BudgetingKnownInputsV1,
): BudgetingKnownInputsV1 {
  return BudgetingKnownInputsSchemaV1.parse({
    ...(known.priorities !== undefined
      && known.priorities.every((value) => explicitBudgetText(source, value))
      ? { priorities: known.priorities }
      : {}),
    ...(known.timeframe !== undefined && explicitBudgetTimeframe(source, known.timeframe)
      ? { timeframe: known.timeframe }
      : {}),
    ...(known.targetAmount !== undefined && explicitBudgetMoney(source, known.targetAmount)
      ? { targetAmount: known.targetAmount }
      : {}),
    ...(known.categories !== undefined
      && known.categories.every((category) => explicitBudgetCategory(source, category))
      ? { categories: known.categories }
      : {}),
  });
}

function inferredBudgetKnown(source: string): Partial<BudgetingKnownInputsV1> {
  const inferred: Partial<BudgetingKnownInputsV1> = {};
  const priority = /\bpriorit(?:y|ize|ise|izing)\b([^.!?]*)/.exec(source)?.[1]?.trim();
  if (priority !== undefined && priority.length > 0) inferred.priorities = [priority];

  const dates = [...source.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map((match) => match[1]!);
  if (dates.length >= 2) inferred.timeframe = { start: dates[0]!, end: dates[1]! };

  const total = /\btotal(?:\s+(?:budget|amount))?\s*(?:is|of|:)?\s*(?:(usd|idr|eur|gbp|\$|€|£)\s*)?([0-9][0-9,]*(?:\.[0-9]+)?)\s*(usd|idr|eur|gbp|dollars?|euros?|pounds?)?\b/.exec(source);
  const totalMoney = moneyFromParts(total?.[1], total?.[2], total?.[3]);
  if (totalMoney !== undefined) inferred.targetAmount = totalMoney;

  const categorySection = /\b(?:include|categories?(?:\s+include)?|allocate)\b([^.!?]*)/.exec(source)?.[1];
  if (categorySection !== undefined) {
    const categories: Array<{ name: string; targetAmount?: { amount: string; currency: string } }> = [];
    const pattern = /(?:^|,|\band\b)\s*([a-z][a-z &'-]*?)\s*(usd|idr|eur|gbp|\$|€|£)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g;
    for (const match of categorySection.matchAll(pattern)) {
      const name = match[1]!.replace(/^(?:and|include)\s+/i, '').trim();
      const money = moneyFromParts(match[2], match[3], undefined);
      if (name.length === 0 || money === undefined || /\btotal\b/.test(name)) continue;
      categories.push({ name, targetAmount: money });
    }
    if (categories.length > 0) inferred.categories = categories;
  }
  return inferred;
}

function moneyFromParts(
  firstCurrency: string | undefined,
  amount: string | undefined,
  secondCurrency: string | undefined,
): { amount: string; currency: string } | undefined {
  if (amount === undefined) return undefined;
  const currency = normalizeBudgetCurrency(firstCurrency ?? secondCurrency);
  return currency === undefined ? undefined : { amount: amount.replaceAll(',', ''), currency };
}

function normalizeBudgetCurrency(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLocaleLowerCase();
  if (normalized === '$' || normalized === 'usd' || normalized === 'dollar' || normalized === 'dollars') return 'USD';
  if (normalized === 'idr' || normalized === 'rupiah') return 'IDR';
  if (normalized === 'eur' || normalized === '€' || normalized === 'euro' || normalized === 'euros') return 'EUR';
  if (normalized === 'gbp' || normalized === '£' || normalized === 'pound' || normalized === 'pounds') return 'GBP';
  return undefined;
}

function explicitBudgetText(source: string, value: string): boolean {
  const sourceWords = new Set(sourceWordsFor(source));
  const valueWords = sourceWordsFor(value);
  if (valueWords.length === 0) return false;
  const overlap = valueWords.filter((word) => sourceWords.has(word)).length;
  return overlap >= Math.max(1, Math.ceil(valueWords.length * 0.4));
}

function explicitBudgetTimeframe(
  source: string,
  timeframe: NonNullable<BudgetingKnownInputsV1['timeframe']>,
): boolean {
  const years = [timeframe.start.slice(0, 4), timeframe.end.slice(0, 4)];
  if (years.some((year) => source.includes(year))) return true;
  const months = [timeframe.start, timeframe.end].map((date) => monthName(date));
  return months.some((month) => month !== undefined && source.includes(month));
}

function explicitBudgetMoney(
  source: string,
  money: NonNullable<BudgetingKnownInputsV1['targetAmount']>,
): boolean {
  const [whole, fraction = ''] = money.amount.split('.');
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '');
  const normalizedFraction = fraction.replace(/0+$/, '');
  const amountForms = [
    money.amount,
    normalizedFraction.length === 0
      ? normalizedWhole
      : `${normalizedWhole}.${normalizedFraction}`,
  ].map((value) => value.replaceAll(/[^0-9]/g, ''));
  const sourceDigits = source.replaceAll(/[^0-9]/g, '');
  const currencies = [
    money.currency.toLocaleLowerCase(),
    ...(money.currency === 'USD' ? ['dollar', 'dollars'] : []),
    ...(money.currency === 'IDR' ? ['rupiah'] : []),
  ];
  return amountForms.some((amount) => amount.length > 0 && sourceDigits.includes(amount))
    && currencies.some((currency) => source.includes(currency));
}

function explicitBudgetCategory(
  source: string,
  category: NonNullable<BudgetingKnownInputsV1['categories']>[number],
): boolean {
  if (!explicitBudgetText(source, category.name)) return false;
  return category.targetAmount === undefined || explicitBudgetMoney(source, category.targetAmount);
}

function sourceWordsFor(value: string): string[] {
  return value.toLocaleLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
}

function monthName(date: string): string | undefined {
  const month = Number(date.slice(5, 7));
  return Number.isInteger(month) && month >= 1 && month <= 12
    ? [
        'january', 'february', 'march', 'april', 'may', 'june',
        'july', 'august', 'september', 'october', 'november', 'december',
      ][month - 1]
    : undefined;
}
