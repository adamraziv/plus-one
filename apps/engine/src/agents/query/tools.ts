import { analystSandboxToolId } from '@plus-one/runtime';
import type { RoleAgentTools } from '../../mastra/role-agent.js';

export type QueryRoleToolSurface =
  | 'lead'
  | 'query-maker'
  | 'query-checker'
  | 'analyst-maker'
  | 'analyst-checker';

export function splitQueryRoleTools(tools: RoleAgentTools, role: QueryRoleToolSurface): RoleAgentTools {
  const entries = Object.entries(tools as Record<string, unknown>);
  if (role === 'query-maker') {
    return Object.fromEntries(entries.filter(([toolId]) =>
      toolId.startsWith('query.') && toolId !== analystSandboxToolId)) as RoleAgentTools;
  }
  if (role === 'analyst-maker' || role === 'analyst-checker') {
    return Object.fromEntries(entries.filter(([toolId]) => toolId === analystSandboxToolId)) as RoleAgentTools;
  }
  return {};
}
