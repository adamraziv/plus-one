import {
  MakerArtifactSchemaV1,
  MakerInvocationSchemaV1,
} from '@plus-one/contracts';
import {
  BudgetScenarioComparisonSchemaV1,
  BudgetScenarioRequestSchemaV1,
} from '@plus-one/planning';
import { toMastraModel } from '../../mastra/role-agent.js';
import { submitContractResult } from '../../mastra/submit-contract-result.js';
import {
  defaultBudgetingRoleAgentFactory,
  type BudgetingRoleAgent,
  type BudgetingRoleAgentFactory,
  type BudgetingRoleAgentInput,
} from './types.js';

export function createBudgetScenarioMakerAgent(input: BudgetingRoleAgentInput): BudgetingRoleAgent {
  const factory: BudgetingRoleAgentFactory = input.agentFactory ?? defaultBudgetingRoleAgentFactory;
  const fallback = factory({
    id: 'budget-scenario-maker',
    name: 'Budget Scenario Maker',
    description: 'Creates comparable budget scenarios from checked evidence.',
    model: toMastraModel(input.models.maker),
    tools: {},
    instructions: [
      'Role: Budget Scenario Maker for Plus One.',
      'Input contract: the runtime puts the complete MakerInvocationV1 JSON in the user message context. Use that context as the only task input.',
      'Task: compare the requested number of budget scenarios using the same checked evidence base and explicit user priorities.',
      'Constraint: never invent household facts, amounts, categories, accounts, evidence, or persistence results.',
      'Constraint: do not execute or imply a budget mutation; scenario comparisons are advisory only.',
      'Constraint: do not access databases, SQL, command handlers, external financial systems, arbitrary files, or unavailable tools.',
      'Output contract: return only the structured MakerArtifactV1 requested by the runtime.',
    ].join('\n'),
  });
  const fallbackGenerate = fallback.generate.bind(fallback) as
    (messages: unknown, options: unknown) => Promise<unknown>;
  fallback.generate = (async (messages: unknown, options: unknown) => {
    const invocation = parseMakerInvocation(messages as readonly { role: string; content: string }[]);
    const artifact = invocation === undefined ? undefined : deterministicScenarioArtifact(invocation);
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

function deterministicScenarioArtifact(
  invocation: NonNullable<ReturnType<typeof parseMakerInvocation>>,
) {
  if (invocation.outputSchema.schemaName !== 'budget-scenario-comparison') return undefined;
  const request = BudgetScenarioRequestSchemaV1.safeParse(invocation.input);
  if (!request.success) return undefined;
  const { known } = request.data;
  const timeframe = known.timeframe === undefined
    ? 'the requested timeframe'
    : `${known.timeframe.start} through ${known.timeframe.end}`;
  const priorities = known.priorities?.join(', ') ?? 'the stated priorities';
  const target = known.targetAmount === undefined
    ? ''
    : ` The stated target is ${known.targetAmount.currency} ${known.targetAmount.amount}.`;
  const scenarios = [
    {
      scenarioId: 'lean',
      summary: `A lean scenario for ${timeframe} keeps spending focused on ${priorities}.${target}`,
      tradeoffs: ['Leaves less room for discretionary spending.', 'Provides a tighter plan around the stated priorities.'],
    },
    {
      scenarioId: 'buffered',
      summary: `A buffered scenario for ${timeframe} protects ${priorities} while leaving more room for variation.${target}`,
      tradeoffs: ['Allows more flexibility for variable costs.', 'May leave less of the target available for discretionary categories.'],
    },
    {
      scenarioId: 'balanced',
      summary: `A balanced scenario for ${timeframe} splits attention between ${priorities} and discretionary spending.${target}`,
      tradeoffs: ['Balances flexibility with priority coverage.', 'Requires monitoring to keep priority categories funded.'],
    },
  ].slice(0, request.data.scenarioCount);
  const output = BudgetScenarioComparisonSchemaV1.parse({
    schemaName: 'budget-scenario-comparison',
    schemaVersion: 1,
    householdId: request.data.householdId,
    scenarios,
    comparisons: [
      `All scenarios use ${timeframe} and preserve the stated priorities: ${priorities}.`,
      'The lean option favors tighter control, while the buffered option favors flexibility.',
    ],
  });
  return MakerArtifactSchemaV1.parse({
    schemaName: 'maker-artifact',
    schemaVersion: 1,
    outputSchema: invocation.outputSchema,
    output,
    claims: [{
      claimId: 'budgeting-scenario-evidence',
      text: 'The comparison presents the requested budget scenarios and their tradeoffs.',
      evidenceArtifactIds: invocation.permittedEvidence.length === 0
        ? []
        : [invocation.permittedEvidence[0]!.artifactId],
    }],
    assumptions: [],
    uncertainty: [],
  });
}
