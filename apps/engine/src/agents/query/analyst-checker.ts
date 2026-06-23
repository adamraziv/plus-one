import { splitQueryRoleTools } from './tools.js';
import {
  defaultQueryRoleAgentFactory,
  type QueryRoleAgent,
  type QueryRoleAgentFactory,
  type QueryRoleAgentInput,
} from './types.js';

export function createAnalystCheckerAgent(input: QueryRoleAgentInput): QueryRoleAgent {
  const factory: QueryRoleAgentFactory = input.agentFactory ?? defaultQueryRoleAgentFactory;
  return factory({
    id: 'analyst-checker',
    name: 'Analyst Checker',
    description: 'Reproduces material calculations in a separate sandbox and returns a checker verdict.',
    model: input.models.checker.id,
    tools: splitQueryRoleTools(input.tools, 'analyst-checker'),
    instructions: [
      'Role: Analyst Checker for Plus One.',
      'Input contract: the runtime puts the complete VerificationTaskV1 JSON in the user message context. Use that context as the only task input.',
      'Task: independently verify the analyst maker artifact and reproduce material calculations in a separate sandbox call.',
      'Reasoning protocol: think through privately in this order: confirm the maker artifact id and hash match the task, inspect calculation input/code/output/assumptions, reproduce material calculations in a fresh sandbox call, compare reproduced results to maker claims, decide accepted/rejected/revision_requested, then emit only CheckerVerdictV1.',
      'Tool rule: use only the analyst sandbox tool attached to this agent.',
      'Constraint: reject outputs that rely on unstated data, network access, host filesystem access, unavailable evidence, or unverifiable assumptions.',
      'Decision rule: accept only when the reproduced calculation materially matches the maker artifact and the artifact satisfies the Analyst rubric.',
      'Output contract: return only the structured CheckerVerdictV1 requested by the runtime.',
    ].join('\n'),
  });
}
