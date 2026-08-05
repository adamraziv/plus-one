import {
  MakerArtifactSchemaV1,
  MakerInvocationSchemaV1,
} from '@plus-one/contracts';
import {
  BudgetingIntakeRequestSchemaV1,
  PlanningClarificationSchemaV1,
  missingBudgetPlanFields,
  missingBudgetScenarioFields,
} from '@plus-one/planning';
import { toMastraModel } from '../../mastra/role-agent.js';
import { submitContractResult } from '../../mastra/submit-contract-result.js';
import {
  defaultBudgetingRoleAgentFactory,
  type BudgetingRoleAgent,
  type BudgetingRoleAgentFactory,
  type BudgetingRoleAgentInput,
} from './types.js';

export function createBudgetMakerAgent(input: BudgetingRoleAgentInput): BudgetingRoleAgent {
  const factory: BudgetingRoleAgentFactory = input.agentFactory ?? defaultBudgetingRoleAgentFactory;
  const fallback = factory({
    id: 'budget-maker',
    name: 'Budget Maker',
    description: 'Creates checked budget proposals or precise planning clarifications.',
    model: toMastraModel(input.models.maker),
    tools: {},
    instructions: [
      'Role: Budget Maker for Plus One.',
      'Input contract: the runtime puts the complete MakerInvocationV1 JSON in the user message context. Use that context as the only task input.',
      'Task: produce either one planning clarification for an incomplete budgeting intake or one checked budget/scenario output for a complete typed request.',
      'Reasoning protocol: read the typed input, use only explicit user-owned facts and permitted evidence, resolve whether the request is complete, then emit only MakerArtifactV1.',
      'Constraint: never invent a budget amount, currency, timeframe, priority, category, account, evidence, or persistence result.',
      'Constraint: never expose internal household, database, account, artifact, or evidence identifiers in output claims or questions.',
      'Constraint: do not claim a budget was created; mutation execution and readback belong to the checked runtime.',
      'Constraint: do not access databases, SQL, command handlers, external financial systems, arbitrary files, or unavailable tools.',
      'Output contract: return only the structured MakerArtifactV1 requested by the runtime.',
    ].join('\n'),
  });
  const fallbackGenerate = fallback.generate.bind(fallback) as
    (messages: unknown, options: unknown) => Promise<unknown>;
  fallback.generate = (async (messages: unknown, options: unknown) => {
    const invocation = parseMakerInvocation(messages as readonly { role: string; content: string }[]);
    const artifact = invocation === undefined ? undefined : deterministicIntakeArtifact(invocation);
    if (artifact === undefined) return fallbackGenerate(messages, options);
    return submitContractResult(options, artifact);
  }) as typeof fallback.generate;
  return fallback;
}

function parseMakerInvocation(messages: readonly { role: string; content: string }[]) {
  const content = [...messages].reverse().find((message) => message.role === 'user')?.content;
  if (content === undefined) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    return undefined;
  }
  const parsed = MakerInvocationSchemaV1.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

function deterministicIntakeArtifact(
  invocation: NonNullable<ReturnType<typeof parseMakerInvocation>>,
) {
  if (invocation.outputSchema.schemaName !== 'planning-clarification') return undefined;
  const request = BudgetingIntakeRequestSchemaV1.safeParse(invocation.input);
  if (!request.success) return undefined;
  const missing = request.data.intent === 'budget_plan'
    ? missingBudgetPlanFields(request.data.known)
    : missingBudgetScenarioFields(request.data.known);
  if (missing.length === 0) return undefined;
  const output = PlanningClarificationSchemaV1.parse({
    schemaName: 'planning-clarification',
    schemaVersion: 1,
    missingFields: missing,
    questions: missing.map(questionFor),
    reason: 'I need these budget details before I can prepare a checked plan.',
  });
  return MakerArtifactSchemaV1.parse({
    schemaName: 'maker-artifact',
    schemaVersion: 1,
    outputSchema: invocation.outputSchema,
    output,
    claims: [{
      claimId: 'budgeting-intake-clarification',
      text: 'The budget request is missing user-visible planning details.',
      evidenceArtifactIds: [],
    }],
    assumptions: [],
    uncertainty: missing.map((field) => `Missing ${field}.`),
  });
}

function questionFor(
  field: ReturnType<typeof missingBudgetPlanFields>[number],
): string {
  if (field === 'priority') return 'What should this budget prioritize?';
  if (field === 'timeframe') return 'What timeframe should this budget cover?';
  if (field === 'target_amount') return 'What total amount should this budget cover, and in which currency?';
  return 'Which budget categories should be included, and how should the amount be allocated across them?';
}
