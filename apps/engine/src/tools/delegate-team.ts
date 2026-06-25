import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { AccountingLeadRequestSchemaV1 } from '@plus-one/accounting';
import {
  InboundChannelMessageSchemaV1,
  JsonValueSchema,
  TeamResultEnvelopeSchemaV1,
  type InboundChannelMessageV1,
  type JsonValue,
  type TeamResultEnvelopeV1,
} from '@plus-one/contracts';
import type { TeamDefinition } from '@plus-one/runtime';

export interface OrchestratorTeamRuntime {
  runTeamLead(input: {
    message: InboundChannelMessageV1;
    team: TeamDefinition;
    request: JsonValue;
    signal: AbortSignal;
  }): Promise<TeamResultEnvelopeV1>;
}

export function createDelegateTeamTool(input: {
  teams: ReadonlyMap<string, TeamDefinition>;
  teamRuntime: OrchestratorTeamRuntime;
  getActiveInvocation(): { message: InboundChannelMessageV1; signal: AbortSignal } | undefined;
}) {
  const teamIds = [...input.teams.keys()] as [string, ...string[]];
  const jsonObjectSchema = z.record(z.string(), JsonValueSchema);
  const toolInputSchema = z.object({
    team: z.enum(teamIds),
    request: jsonObjectSchema,
  }).strict();
  return createTool({
    id: 'delegateTeam',
    description: `Delegate one checked task to a registered specialist team lead. Use exact team ids: ${teamIds.join(', ')}. request must match the selected team's JSON schema and must never be a JSON-encoded string.`,
    inputSchema: toolInputSchema,
    outputSchema: TeamResultEnvelopeSchemaV1,
    execute: async (inputData) => {
      const context = toolInputSchema.parse(inputData);
      validateRequest(context.team, context.request);
      const active = input.getActiveInvocation();
      if (active === undefined) throw new Error('No active orchestrator invocation.');
      const team = input.teams.get(context.team);
      if (team === undefined) throw new Error(`Unknown team: ${context.team}`);
      const result = TeamResultEnvelopeSchemaV1.parse(await input.teamRuntime.runTeamLead({
        message: InboundChannelMessageSchemaV1.parse(active.message),
        team,
        request: context.request as JsonValue,
        signal: active.signal,
      }));
      return result;
    },
  });
}

function validateRequest(team: string, request: Record<string, JsonValue>): void {
  if (team !== 'accounting') return;
  AccountingLeadRequestSchemaV1.parse(request);
}
