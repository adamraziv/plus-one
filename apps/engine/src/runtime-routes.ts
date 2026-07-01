import { registerApiRoute } from '@mastra/core/server';
import {
  ChannelCommandResultSchemaV1,
  InboundChannelMessageSchemaV1,
  type ChannelCommandResultV1,
  type InboundChannelMessageV1,
} from '@plus-one/contracts';
import { ZodError } from 'zod';
import type { AgentSystem } from './agent-catalog.js';
import { OrchestratorAgent } from './agents/orchestrator.js';
import type { EngineConfig } from './config.js';
import type { OrchestratorSessionMemoryPort } from './memory/orchestrator-session-memory.js';
import type { OrchestratorTeamRuntime } from './tools/delegate-team.js';
import { runOrchestratorLoop } from './workflows/orchestrator-loop.js';
import type { Mastra } from '@mastra/core';

export function createRuntimeRoutes(input: {
  config: EngineConfig;
  agentSystem: AgentSystem;
  teamRuntime: OrchestratorTeamRuntime;
  orchestrator?: OrchestratorAgent;
  sessionMemory?: OrchestratorSessionMemoryPort;
  getMastra?: () => Mastra;
  commands?: { handle(message: InboundChannelMessageV1): Promise<ChannelCommandResultV1 | undefined> };
}) {
  const orchestrator = input.orchestrator ?? new OrchestratorAgent({
    model: input.config.models.orchestrator,
    teams: input.agentSystem.teams,
    teamRuntime: input.teamRuntime,
    ...(input.sessionMemory === undefined ? {} : { sessionMemory: input.sessionMemory }),
  });

  return [
    registerApiRoute('/plus-one/inbound', {
      method: 'POST',
      requiresAuth: false,
      handler: async (context) => {
        try {
          const message = InboundChannelMessageSchemaV1.parse(await context.req.json());
          const commandResult = ChannelCommandResultSchemaV1.optional().parse(
            await input.commands?.handle(message),
          );
          if (commandResult !== undefined) {
            return context.json({
              status: 'command-handled',
              command: commandResult.command,
              body: commandResult.body,
              conversationId: commandResult.conversationId,
            });
          }

          if (input.getMastra === undefined) {
            return context.json(await orchestrator.run({ message }));
          }
          const workflow = input.getMastra().getWorkflow('orchestrator-loop');
          return context.json(await runOrchestratorLoop({ workflow, message }));
        } catch (error) {
          if (error instanceof ZodError) {
            return context.json({
              error: 'Invalid inbound-channel-message',
              issues: error.issues.map((issue) => ({
                path: issue.path.join('.'),
                message: issue.message,
              })),
            }, 400);
          }
          throw error;
        }
      },
    }),
  ];
}
