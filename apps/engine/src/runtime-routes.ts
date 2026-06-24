import { registerApiRoute } from '@mastra/core/server';
import { InboundChannelMessageSchemaV1 } from '@plus-one/contracts';
import type { AgentSystem } from './agent-catalog.js';
import { OrchestratorAgent } from './agents/orchestrator.js';
import type { EngineConfig } from './config.js';
import type { OrchestratorTeamRuntime } from './tools/delegate-team.js';

export function createRuntimeRoutes(input: {
  config: EngineConfig;
  agentSystem: AgentSystem;
  teamRuntime: OrchestratorTeamRuntime;
}) {
  const orchestrator = new OrchestratorAgent({
    model: input.config.models.orchestrator,
    teams: input.agentSystem.teams,
    teamRuntime: input.teamRuntime,
  });

  return [
    registerApiRoute('/plus-one/inbound', {
      method: 'POST',
      requiresAuth: false,
      handler: async (context) => {
        const message = InboundChannelMessageSchemaV1.parse(await context.req.json());
        return context.json(await orchestrator.run({ message }));
      },
    }),
  ];
}
