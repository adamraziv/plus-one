import {
  CheckerVerdictSchemaV1,
  MakerArtifactSchemaV1,
  VerificationTaskSchemaV1,
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

export function createBudgetScenarioCheckerAgent(input: BudgetingRoleAgentInput): BudgetingRoleAgent {
  const factory: BudgetingRoleAgentFactory = input.agentFactory ?? defaultBudgetingRoleAgentFactory;
  const fallback = factory({
    id: 'budget-scenario-checker',
    name: 'Budget Scenario Checker',
    description: 'Verifies scenario comparisons against their exact checked input.',
    model: toMastraModel(input.models.checker),
    tools: {},
    instructions: [
      'Role: Budget Scenario Checker for Plus One.',
      'Input contract: the runtime puts the complete VerificationTaskV1 JSON in the user message context. Use that context as the only task input.',
      'Task: verify every scenario uses the same evidence, preserves explicit priorities, and reports material tradeoffs without mutation claims.',
      'Constraint: do not access databases, SQL, command handlers, external financial systems, arbitrary files, parent messages, or durable memory.',
      'Output contract: return only the structured CheckerVerdictV1 requested by the runtime.',
    ].join('\n'),
  });
  const fallbackGenerate = fallback.generate.bind(fallback) as
    (messages: unknown, options: unknown) => Promise<unknown>;
  fallback.generate = (async (messages: unknown, options: unknown) => {
    const task = parseVerificationTask(messages as readonly { role: string; content: string }[]);
    const verdict = task === undefined ? undefined : deterministicScenarioVerdict(task);
    if (verdict === undefined) return fallbackGenerate(messages, options);
    return submitContractResult(options, verdict);
  }) as typeof fallback.generate;
  return fallback;
}

function parseVerificationTask(messages: readonly { role: string; content: string }[]) {
  const content = [...messages].reverse().find((message) => message.role === 'user')?.content;
  if (content === undefined) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    return undefined;
  }
  const parsed = VerificationTaskSchemaV1.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

function deterministicScenarioVerdict(
  task: NonNullable<ReturnType<typeof parseVerificationTask>>,
) {
  const request = BudgetScenarioRequestSchemaV1.safeParse(task.makerInput);
  if (!request.success) {
    return undefined;
  }
  const maker = MakerArtifactSchemaV1.safeParse(task.makerArtifact.payload);
  const comparison = maker.success
    ? BudgetScenarioComparisonSchemaV1.safeParse(maker.data.output)
    : undefined;
  const findings: Array<{ code: string; message: string }> = [];
  if (comparison === undefined || !comparison.success) {
    findings.push({
      code: 'budgeting_scenario_invalid',
      message: 'Scenario maker output is not a valid scenario comparison.',
    });
  } else {
    if (comparison.data.householdId !== request.data.householdId) {
      findings.push({
        code: 'budgeting_scenario_household_mismatch',
        message: 'Scenario comparison does not match the requested household.',
      });
    }
    if (comparison.data.scenarios.length !== request.data.scenarioCount) {
      findings.push({
        code: 'budgeting_scenario_count_mismatch',
        message: 'Scenario comparison does not contain the requested number of scenarios.',
      });
    }
    if (new Set(comparison.data.scenarios.map((scenario) => scenario.scenarioId)).size
      !== comparison.data.scenarios.length) {
      findings.push({
        code: 'budgeting_scenario_ids_not_unique',
        message: 'Scenario identifiers must be unique.',
      });
    }
  }
  return CheckerVerdictSchemaV1.parse({
    verdict: findings.length === 0 ? 'accepted' : 'revision_requested',
    coveredArtifactId: task.makerArtifact.artifactId,
    coveredArtifactHash: task.makerArtifact.artifactHash,
    findings,
  });
}
