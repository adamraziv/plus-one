import { createTool } from '@mastra/core/tools';
import {
  InboundChannelMessageSchemaV1,
  TeamResultEnvelopeSchemaV1,
  type InboundChannelMessageV1,
  type JsonValue,
  type TeamResultEnvelopeV1,
} from '@plus-one/contracts';
import type { TeamDefinition } from '@plus-one/runtime';
import {
  DelegateTeamToolInputSchema,
  parseDelegateTeamToolInput,
  requestForRuntime,
} from './delegate-team-schemas.js';

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
  getActiveInvocation(): {
    message: InboundChannelMessageV1;
    signal: AbortSignal;
    delegationCount: number;
    delegationFailed: boolean;
  } | undefined;
}) {
  const teamIds = [...input.teams.keys()];
  return createTool({
    id: 'delegateTeam',
    description: [
      'Delegate one checked task to a registered specialist team lead.',
      `Registered team ids for this runtime are: ${teamIds.join(', ')}.`,
      'The team field must be an exact team id.',
      'The request field must be a JSON object matching the selected team schema.',
      'Use query for checked finance reads.',
      'Use accounting for explicit record, capture, import, reconcile, journal, or chart-of-accounts requests.',
      'Do not use this tool for payments, trades, tax filings, provider account changes, or external financial actions.',
    ].join(' '),
    inputSchema: DelegateTeamToolInputSchema,
    outputSchema: TeamResultEnvelopeSchemaV1,
    execute: async (inputData) => {
      const active = input.getActiveInvocation();
      if (active === undefined) throw new Error('No active orchestrator invocation.');
      if (active.signal.aborted) {
        throw active.signal.reason ?? new DOMException('Delegated team work aborted.', 'AbortError');
      }
      if (active.delegationCount !== 0) {
        active.delegationFailed = true;
        throw new Error('Only one specialist delegation is allowed per orchestrator turn.');
      }
      const context = parseDelegateTeamToolInput(inputData);
      active.delegationCount += 1;
      const team = input.teams.get(context.team);
      if (team === undefined) throw new Error(`Unknown team: ${context.team}`);
      if (active.signal.aborted) {
        throw active.signal.reason ?? new DOMException('Delegated team work aborted.', 'AbortError');
      }
      try {
        const result = TeamResultEnvelopeSchemaV1.parse(await input.teamRuntime.runTeamLead({
          message: InboundChannelMessageSchemaV1.parse(active.message),
          team,
          request: requestForRuntime(context.request),
          signal: active.signal,
        }));
        return result;
      } catch (error) {
        active.delegationFailed = true;
        throw error;
      }
    },
  });
}
