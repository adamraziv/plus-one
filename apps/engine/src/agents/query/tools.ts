import type { ToolsInput } from '@mastra/core/agent';
import { analystSandboxToolId } from '@plus-one/runtime';

export type QueryRoleToolSurface =
  | 'lead'
  | 'query-maker'
  | 'query-checker'
  | 'analyst-maker'
  | 'analyst-checker';

export function splitQueryRoleTools(tools: ToolsInput, role: QueryRoleToolSurface): ToolsInput {
  const entries = Object.entries(tools as Record<string, unknown>);
  if (role === 'query-maker') {
    return Object.fromEntries(entries.filter(([toolId]) =>
      toolId.startsWith('query.') && toolId !== analystSandboxToolId)) as ToolsInput;
  }
  if (role === 'analyst-maker' || role === 'analyst-checker') {
    return Object.fromEntries(entries.filter(([toolId]) => toolId === analystSandboxToolId)) as ToolsInput;
  }
  return {};
}
