import {
  CheckerVerdictSchemaV1,
  MakerArtifactSchemaV1,
  VerificationTaskSchemaV1,
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

export function createBudgetCheckerAgent(input: BudgetingRoleAgentInput): BudgetingRoleAgent {
  const factory: BudgetingRoleAgentFactory = input.agentFactory ?? defaultBudgetingRoleAgentFactory;
  const fallback = factory({
    id: 'budget-checker',
    name: 'Budget Checker',
    description: 'Checks budget proposals and intake clarifications against exact typed input.',
    model: toMastraModel(input.models.checker),
    tools: {},
    instructions: [
      'Role: Budget Checker for Plus One.',
      'Input contract: the runtime puts the complete VerificationTaskV1 JSON in the user message context. Use that context as the only task input.',
      'Task: verify only the supplied maker artifact against the exact typed budgeting request and rubric, then emit only CheckerVerdictV1.',
      'For an intake clarification, verify that every question maps to a missing user-visible field and that no internal identifier or creation claim appears.',
      'For a complete plan or scenario, verify evidence grounding, explicit priorities, amount/date/category reconciliation, and output schema identity.',
      'Constraint: do not access databases, SQL, command handlers, external financial systems, arbitrary files, parent messages, or durable memory.',
      'Output contract: return only the structured CheckerVerdictV1 requested by the runtime.',
    ].join('\n'),
  });
  const fallbackGenerate = fallback.generate.bind(fallback) as
    (messages: unknown, options: unknown) => Promise<unknown>;
  fallback.generate = (async (messages: unknown, options: unknown) => {
    const task = parseVerificationTask(messages as readonly { role: string; content: string }[]);
    const verdict = task === undefined ? undefined : deterministicIntakeVerdict(task);
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

function deterministicIntakeVerdict(
  task: NonNullable<ReturnType<typeof parseVerificationTask>>,
) {
  const request = BudgetingIntakeRequestSchemaV1.safeParse(task.makerInput);
  if (!request.success) return undefined;
  const maker = MakerArtifactSchemaV1.parse(task.makerArtifact.payload);
  const clarification = PlanningClarificationSchemaV1.safeParse(maker.output);
  const expected = request.data.intent === 'budget_plan'
    ? missingBudgetPlanFields(request.data.known)
    : missingBudgetScenarioFields(request.data.known);
  const findings: Array<{ code: string; message: string }> = [];
  if (!clarification.success) {
    findings.push({
      code: 'budgeting_clarification_invalid',
      message: 'Maker output is not a valid planning clarification.',
    });
  } else {
    if (clarification.data.missingFields.length !== expected.length
      || clarification.data.missingFields.some((field) => !expected.includes(field))) {
      findings.push({
        code: 'budgeting_clarification_fields_mismatch',
        message: 'Clarification fields do not match the missing typed budget facts.',
      });
    }
    if (clarification.data.questions.length !== expected.length) {
      findings.push({
        code: 'budgeting_clarification_questions_mismatch',
        message: 'Clarification must contain one question for each missing typed budget fact.',
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
