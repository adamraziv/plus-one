import { registerApiRoute } from '@mastra/core/server';
import { InboundChannelMessageSchemaV1 } from '@plus-one/contracts';
import type { AgentSystem } from './agent-catalog.js';
import { OrchestratorAgent } from './agents/orchestrator.js';
import type { EngineConfig } from './config.js';
import type { OrchestratorTeamRuntime } from './tools/delegate-team.js';
import { runOrchestratorLoop } from './workflows/orchestrator-loop.js';
import type { Mastra } from '@mastra/core';

export function createRuntimeRoutes(input: {
  config: EngineConfig;
  agentSystem: AgentSystem;
  teamRuntime: OrchestratorTeamRuntime;
  orchestrator?: OrchestratorAgent;
  getMastra?: () => Mastra;
}) {
  const orchestrator = input.orchestrator ?? new OrchestratorAgent({
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
        if (input.getMastra === undefined) {
          return context.json(await orchestrator.run({ message }));
        }
        const workflow = input.getMastra().getWorkflow('orchestrator-loop');
        return context.json(await runOrchestratorLoop({ workflow, message }));
      },
    }),
  ];
}
