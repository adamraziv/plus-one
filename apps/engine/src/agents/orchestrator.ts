import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { Agent, type ToolsInput } from '@mastra/core/agent';
import {
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  type TeamResultEnvelopeV1,
  type ChannelKindV1,
  type InboundChannelMessageV1,
  type OrchestratorFinalResponseV1,
} from '@plus-one/contracts';
import type { TeamDefinition } from '@plus-one/runtime';
import { toMastraModel, type EngineLlmModelConfig } from '../mastra/role-agent.js';
import { createDelegateTeamTool, type OrchestratorTeamRuntime } from '../tools/delegate-team.js';

const orchestratorInstructions = [
  'You are the Orchestrator for a household finance agent system.',
  'You are the only user-facing entrypoint.',
  'Answer only from verified context or checked team results.',
  'When calling delegateTeam, use exact team ids, never display names: query, accounting, budgeting, cash-flow, investments-retirement, records-reporting.',
  'delegateTeam input must always be strict JSON, and request must be a JSON object, never a quoted JSON string.',
  'Delegate financial read questions to team id query.',
  'Delegate transaction capture, journal, chart-of-accounts, ingestion, and reconciliation requests to team id accounting.',
  'A request to add, record, capture, import, reconcile, or change accounting data is accounting, not query.',
  'For a message like "add $10 of buying a burger", call accounting once with an object request; do not call query to discover book ids or other metadata.',
  'For query, request must be a full EvidenceRequestV1 object; do not invent one unless the user is actually asking a read question.',
  'For accounting transaction capture, pass request as AccountingLeadRequestV1 with intent transaction_capture and nested TransactionCaptureRequestV1 JSON.',
  'Do not execute payments, trades, tax filings, provider account changes, or external financial actions.',
  'Return the requested OrchestratorFinalResponseV1 object.',
].join('\n');

export class OrchestratorAgent {
  private readonly teams: Map<string, TeamDefinition>;
  private readonly activeInvocation = new AsyncLocalStorage<{
    message: InboundChannelMessageV1;
    signal: AbortSignal;
    teamResults: TeamResultEnvelopeV1[];
  }>();
  readonly agent: Agent<string, ToolsInput, unknown>;
  readonly agentTools: { delegateTeam: ReturnType<typeof createDelegateTeamTool> };

  constructor(private readonly dependencies: {
    model: EngineLlmModelConfig;
    teams: readonly TeamDefinition[];
    teamRuntime: OrchestratorTeamRuntime;
    agentFactory?: (config: ConstructorParameters<typeof Agent<string, ToolsInput, unknown>>[0]) =>
      Agent<string, ToolsInput, unknown>;
  }) {
    this.teams = new Map(dependencies.teams.map((team) => [team.team, team]));
    const teamRuntime: OrchestratorTeamRuntime = {
      runTeamLead: async (input) => {
        const result = await dependencies.teamRuntime.runTeamLead(input);
        this.activeInvocation.getStore()?.teamResults.push(result);
        return result;
      },
    };
    this.agentTools = {
      delegateTeam: createDelegateTeamTool({
        teams: this.teams,
        teamRuntime,
        getActiveInvocation: () => this.activeInvocation.getStore(),
      }),
    };
    this.agent = (dependencies.agentFactory ?? ((config) => new Agent(config)))({
      id: 'orchestrator',
      name: 'Orchestrator',
      description: 'The single entrypoint agent that responds to users and delegates specialized work to team leads.',
      instructions: orchestratorInstructions,
      model: toMastraModel(dependencies.model),
      tools: this.agentTools,
    });
  }

  async run(input: { message: InboundChannelMessageV1; signal?: AbortSignal }): Promise<OrchestratorFinalResponseV1> {
    const message = InboundChannelMessageSchemaV1.parse(input.message);
    const signal = input.signal ?? AbortSignal.timeout(60_000);
    const invocation = { message, signal, teamResults: [] as TeamResultEnvelopeV1[] };
    return this.activeInvocation.run(invocation, async () => {
      const prompt = [
        'InboundChannelMessageV1 context:',
        JSON.stringify(message),
      ].join('\n');
      try {
        const result = await this.agent.generate(prompt, {
          structuredOutput: { schema: OrchestratorFinalResponseSchemaV1, jsonPromptInjection: true },
        });
        return OrchestratorFinalResponseSchemaV1.parse(result.object ?? parseJsonObject(result.text));
      } catch (error) {
        if (invocation.teamResults.length === 0) throw error;
        return responseFromTeamResults(message, invocation.teamResults);
      }
    });
  }
}

function parseJsonObject(text: unknown): unknown {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return undefined;
  return JSON.parse(trimmed.slice(start, end + 1));
}

function responseFromTeamResults(message: InboundChannelMessageV1,
  teamResults: readonly TeamResultEnvelopeV1[]): OrchestratorFinalResponseV1 {
  const [teamResult] = teamResults;
  if (teamResult === undefined) throw new Error('Missing team result for fallback response');
  const body = responseBody(teamResult);
  const response = OrchestratorFinalResponseSchemaV1.parse({
    schemaName: 'orchestrator-final-response',
    schemaVersion: 1,
    responseId: `response_${Date.now()}`,
    householdId: message.householdId,
    conversationId: message.conversationId,
    body,
    policyBoundary: 'personalized_finance',
    citations: citationsFor(teamResult),
    assumptions: teamResult.assumptions,
    freshness: teamResult.freshness.length === 0 ? ['current invocation'] : teamResult.freshness,
    disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
    unsupportedCapabilities: [],
    recommendationActions: [],
    delivery: {
      channel: message.channel,
      destination: destinationFor(message.channel, message.metadata.destination),
      format: message.channel === 'slack' ? 'mrkdwn' : 'plain_text',
    },
    responseHash: createHash('sha256').update(body, 'utf8').digest('hex'),
    createdAt: new Date().toISOString(),
  });
  return response;
}

function responseBody(teamResult: TeamResultEnvelopeV1): string {
  const heading = `${labelForTeam(teamResult.team)} status: ${teamResult.status}`;
  const details = [teamResult.completionReason, ...teamResult.outstanding].filter((value) => value.length > 0);
  return details.length === 0 ? heading : `${heading}\n\n${details.join('\n')}`;
}

function citationsFor(teamResult: TeamResultEnvelopeV1) {
  if (teamResult.claims.length === 0) {
    return [{ label: `${teamResult.team}:team-result`, sourceRef: `team-result:${teamResult.status}` }];
  }
  return teamResult.claims.map((claim) => ({
    label: `${teamResult.team}:${claim.claimId}`,
    artifactId: claim.checkedMakerArtifactIds[0]!,
  }));
}

function labelForTeam(team: string): string {
  if (team === 'accounting') return 'Accounting team';
  if (team === 'query') return 'Query team';
  return `${team} team`;
}

function destinationFor(channel: ChannelKindV1, destination: unknown): Record<string, unknown> {
  if (destination !== null && typeof destination === 'object' && !Array.isArray(destination)) {
    return destination as Record<string, unknown>;
  }
  return channel === 'telegram' ? { chatId: '' } : { channelId: '' };
}
