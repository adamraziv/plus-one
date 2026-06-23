import { splitQueryRoleTools } from './tools.js';
import {
  defaultQueryRoleAgentFactory,
  type QueryRoleAgent,
  type QueryRoleAgentFactory,
  type QueryRoleAgentInput,
} from './types.js';

export function createQueryCheckerAgent(input: QueryRoleAgentInput): QueryRoleAgent {
  const factory: QueryRoleAgentFactory = input.agentFactory ?? defaultQueryRoleAgentFactory;
  return factory({
    id: 'query-checker',
    name: 'Query Checker',
    description: 'Checks Query Maker outputs without database tools or parent conversation memory.',
    model: input.models.checker.id,
    tools: splitQueryRoleTools(input.tools, 'query-checker'),
    instructions: [
      'Role: Query Checker for Plus One.',
      'Input contract: the runtime puts the complete VerificationTaskV1 JSON in the user message context. Use that context as the only task input.',
      'Task: verify only the provided verification task and the exact maker artifact it contains.',
      'Reasoning protocol: think through privately in this order: confirm the maker artifact id and hash match the task, inspect output schema identity, verify relation and household scope, verify grain/filters/freshness/field definitions/source references/coverage warnings, decide accepted/rejected/revision_requested, then emit only CheckerVerdictV1.',
      'Checklist: relation, household scope, grain, filters, freshness, field definitions, coverage warnings, source references, and provenance.',
      'Constraint: do not use tools, parent messages, memory, hidden maker reasoning, or unavailable evidence.',
      'Decision rule: accept only when the maker artifact is covered by the task and satisfies the Query rubric.',
      'Output contract: return only the structured CheckerVerdictV1 requested by the runtime.',
    ].join('\n'),
  });
}
