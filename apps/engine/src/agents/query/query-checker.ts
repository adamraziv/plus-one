import {
  CheckerVerdictSchemaV1,
  EvidenceRequestSchemaV1,
  MakerArtifactSchemaV1,
  QueryResultSchemaV1,
  VerificationTaskSchemaV1,
} from '@plus-one/contracts';
import { splitQueryRoleTools } from './tools.js';
import { toMastraModel } from '../../mastra/role-agent.js';
import { submitContractResult } from '../../mastra/submit-contract-result.js';
import {
  defaultQueryRoleAgentFactory,
  type QueryRoleAgent,
  type QueryRoleAgentFactory,
  type QueryRoleAgentInput,
} from './types.js';

export function createQueryCheckerAgent(input: QueryRoleAgentInput): QueryRoleAgent {
  const factory: QueryRoleAgentFactory = input.agentFactory ?? defaultQueryRoleAgentFactory;
  const fallback = factory({
    id: 'query-checker',
    name: 'Query Checker',
    description: 'Checks Query Maker outputs without database tools or parent conversation memory.',
    model: toMastraModel(input.models.checker),
    tools: splitQueryRoleTools(input.tools, 'query-checker'),
    instructions: [
      'Role: Query Checker for Plus One.',
      'Input contract: the runtime puts the complete VerificationTaskV1 JSON in the user message context. Use that context as the only task input.',
      'Task: verify only the provided verification task and the exact maker artifact it contains.',
      'Request-context rule: use VerificationTaskV1.makerInput as the original request context when checking grain, filters, freshness, intended use, and household scope.',
      'Reasoning protocol: think through privately in this order: confirm the maker artifact id and hash match the task, inspect output schema identity, verify relation and household scope, verify grain/filters/freshness/field definitions/source references/coverage warnings, decide accepted/rejected/revision_requested, then emit only CheckerVerdictV1.',
      'Household-scope rule: when QueryResultV1.sourceReferences includes filter=household_id:eq:<id>, treat that as explicit evidence of the enforced household filter even if the filtered column is not repeated in each row.',
      'Checklist: relation, household scope, grain, filters, freshness, field definitions, coverage warnings, source references, and provenance.',
      'Constraint: do not use tools, parent messages, memory, hidden maker reasoning, or unavailable evidence.',
      'Decision rule: accept only when the maker artifact is covered by the task and satisfies the Query rubric.',
      'Output contract: return only the structured CheckerVerdictV1 requested by the runtime.',
    ].join('\n'),
  });
  const fallbackGenerate = fallback.generate.bind(fallback) as
    (messages: unknown, options: unknown) => Promise<unknown>;
  fallback.generate = (async (messages: unknown, options: unknown) => {
    const task = parseVerificationTask(messages as readonly { role: string; content: string }[]);
    if (task === undefined) return fallbackGenerate(messages, options);
    const maker = MakerArtifactSchemaV1.parse(task.makerArtifact.payload);
    if (maker.outputSchema.schemaName !== 'query-result') return fallbackGenerate(messages, options);
    const result = QueryResultSchemaV1.parse(maker.output);
    const findings = queryFindings(task, result);
    return submitContractResult(options, CheckerVerdictSchemaV1.parse({
        verdict: findings.length === 0 ? 'accepted' : 'revision_requested',
        coveredArtifactId: task.makerArtifact.artifactId,
        coveredArtifactHash: task.makerArtifact.artifactHash,
        findings,
      }));
  }) as typeof fallback.generate;
  return fallback;
}

function parseVerificationTask(messages: readonly { role: string; content: string }[]) {
  const content = [...messages].reverse().find((message) => message.role === 'user')?.content;
  if (content === undefined) return undefined;
  const parsed = VerificationTaskSchemaV1.safeParse(JSON.parse(content));
  return parsed.success ? parsed.data : undefined;
}

function queryFindings(
  task: NonNullable<ReturnType<typeof parseVerificationTask>>,
  result: ReturnType<typeof QueryResultSchemaV1.parse>,
) {
  const findings: Array<{ code: string; message: string }> = [];
  const request = EvidenceRequestSchemaV1.safeParse(task.makerInput);
  if (request.success && !sameStrings(result.grain, request.data.desiredGrain)) {
    findings.push({ code: 'query_grain_mismatch', message: 'Query result grain does not match requested grain.' });
  }
  if (!result.sourceReferences.includes(`filter=household_id:eq:${task.householdId}`)) {
    findings.push({ code: 'query_household_scope_missing', message: 'Query result does not prove household scope.' });
  }
  for (const warning of result.coverageWarnings) {
    findings.push({ code: 'query_coverage_warning', message: warning });
  }
  return findings;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
