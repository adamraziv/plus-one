import { Agent } from '@mastra/core/agent';
import {
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  type InboundChannelMessageV1,
  type OrchestratorFinalResponseV1,
} from '@plus-one/contracts';
import type { TeamDefinition } from '@plus-one/runtime';
import type { EngineLlmModelConfig } from '../mastra/role-agent.js';
import { createDelegateTeamTool, type OrchestratorTeamRuntime } from '../tools/delegate-team.js';

const orchestratorInstructions = [
  'You are the Orchestrator for a household finance agent system.',
  'You are the only user-facing entrypoint.',
  'Answer only from verified context or checked team results.',
  'Delegate financial read questions to the Query Team.',
  'Do not execute payments, trades, tax filings, provider account changes, or external financial actions.',
  'Return the requested OrchestratorFinalResponseV1 object.',
].join('\n');

export class OrchestratorAgent {
  private readonly teams: Map<string, TeamDefinition>;
  private activeInvocation?: { message: InboundChannelMessageV1; signal: AbortSignal };
  readonly agent: Agent;
  readonly agentTools: NonNullable<ConstructorParameters<typeof Agent>[0]['tools']>;

  constructor(private readonly dependencies: {
    model: EngineLlmModelConfig;
    teams: readonly TeamDefinition[];
    teamRuntime: OrchestratorTeamRuntime;
    agentFactory?: (config: ConstructorParameters<typeof Agent>[0]) => Agent;
  }) {
    this.teams = new Map(dependencies.teams.map((team) => [team.team, team]));
    this.agentTools = {
      delegateTeam: createDelegateTeamTool({
        teams: this.teams,
        teamRuntime: dependencies.teamRuntime,
        getActiveInvocation: () => this.activeInvocation,
      }),
    };
    this.agent = (dependencies.agentFactory ?? ((config) => new Agent(config)))({
      id: 'orchestrator',
      name: 'Orchestrator',
      description: 'The single entrypoint agent that responds to users and delegates specialized work to team leads.',
      instructions: orchestratorInstructions,
      model: dependencies.model.id,
      tools: this.agentTools,
    });
  }

  async run(input: { message: InboundChannelMessageV1; signal?: AbortSignal }): Promise<OrchestratorFinalResponseV1> {
    const message = InboundChannelMessageSchemaV1.parse(input.message);
    const signal = input.signal ?? AbortSignal.timeout(60_000);
    this.activeInvocation = { message, signal };
    try {
      const result = await this.agent.generate([
        `householdId: ${message.householdId}`,
        `conversationId: ${message.conversationId}`,
        `message: ${message.body}`,
      ].join('\n'), {
        structuredOutput: { schema: OrchestratorFinalResponseSchemaV1 },
      });
      return OrchestratorFinalResponseSchemaV1.parse(result.object);
    } finally {
      this.activeInvocation = undefined;
    }
  }
}
