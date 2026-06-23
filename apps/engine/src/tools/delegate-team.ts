import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  InboundChannelMessageSchemaV1,
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
  return createTool({
    id: 'delegateTeam',
    description: 'Delegate one checked task to a registered specialist team lead.',
    inputSchema: z.object({
      team: z.string(),
      request: z.unknown(),
    }).strict(),
    outputSchema: TeamResultEnvelopeSchemaV1,
    execute: async (inputData) => {
      const context = z.object({ team: z.string(), request: z.unknown() }).strict().parse(inputData);
      const active = input.getActiveInvocation();
      if (active === undefined) throw new Error('No active orchestrator invocation.');
      const team = input.teams.get(context.team);
      if (team === undefined) throw new Error(`Unknown team: ${context.team}`);
      return TeamResultEnvelopeSchemaV1.parse(await input.teamRuntime.runTeamLead({
        message: InboundChannelMessageSchemaV1.parse(active.message),
        team,
        request: context.request as JsonValue,
        signal: active.signal,
      }));
    },
  });
}
