import { createAnalystCheckerAgent } from './analyst-checker.js';
import { createAnalystMakerAgent } from './analyst-maker.js';
import { createQueryCheckerAgent } from './query-checker.js';
import { createQueryMakerAgent } from './query-maker.js';
import { createQueryTeamLeadAgent } from './team-lead.js';
import type { QueryRoleAgent, QueryRoleAgentInput } from './types.js';

export { createAnalystCheckerAgent } from './analyst-checker.js';
export { createAnalystMakerAgent } from './analyst-maker.js';
export { createQueryCheckerAgent } from './query-checker.js';
export { createQueryMakerAgent } from './query-maker.js';
export { createQueryTeamLeadAgent } from './team-lead.js';
export { splitQueryRoleTools } from './tools.js';
export type { QueryRoleAgent, QueryRoleAgentFactory, QueryRoleAgentInput, QueryRoleAgentModels } from './types.js';

export function createQueryRoleAgents(input: QueryRoleAgentInput): Record<string, QueryRoleAgent> {
  return {
    'query-lead': createQueryTeamLeadAgent(input),
    'query-maker': createQueryMakerAgent(input),
    'query-checker': createQueryCheckerAgent(input),
    'analyst-maker': createAnalystMakerAgent(input),
    'analyst-checker': createAnalystCheckerAgent(input),
  };
}
