import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { Agent, type ToolsInput } from '@mastra/core/agent';
import { z } from 'zod';
import {
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  type ChannelKindV1,
  type InboundChannelMessageV1,
  type OrchestratorFinalResponseV1,
  type TeamResultEnvelopeV1,
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
  'For internal Plus One ledger work, your next action must be delegateTeam with team accounting; do not answer directly first.',
  'Do not refuse internal ledger capture as an external financial action; the accounting team will return a checked proposal or clarification without posting externally.',
  'Do not ask the user to confirm transaction capture directly; delegateTeam accounting must ask any needed clarification.',
  'For a message like "add $10 of buying a burger", call accounting once with an object request; do not call query to discover book ids or other metadata.',
  'For query, pass request as query-lead-request-draft unless a full EvidenceRequestV1 is already available.',
  'For accounting transaction capture, pass request as AccountingLeadRequestV1 with intent transaction_capture and nested transaction-capture-request-draft JSON.',
  'In transaction-capture-request-draft.known, include user-stated amount, currency, and occurredOn; preserve user-stated account/category names as paymentAccountName and categoryName, never as internal ids.',
  'Do not execute payments, trades, tax filings, provider account changes, or external financial actions.',
  'Return the requested OrchestratorFinalResponseV1 object.',
].join('\n');

const finalizerInstructions = [
  'You serialize the Orchestrator final answer for Plus One.',
  'Use only the supplied inbound message, main orchestrator result, and checked team results.',
  'Do not call tools.',
  'Do not invent checked facts, citations, timestamps, ids, hashes, account data, or transaction confirmations.',
  'If the main result says more information is needed, preserve that in body.',
  'Return only the requested structured draft object.',
].join('\n');

const citationDraftSchema = z.object({
  label: z.string().min(1).max(512),
  artifactId: z.string().regex(/^artifact_[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
  sourceRef: z.string().min(1).max(512).optional(),
}).strict();

const OrchestratorResponseDraftSchema = z.object({
  body: z.string().min(1).max(32_000),
  policyBoundary: z.enum(['personalized_finance', 'informational_only', 'unsupported_capability', 'operational']),
  citations: z.array(citationDraftSchema).default([]),
  assumptions: z.array(z.string().min(1).max(2_000)).default([]),
  freshness: z.array(z.string().min(1).max(2_000)).default(['current invocation only']),
  disclaimer: z.string().min(1).max(2_000)
    .default('Plus One is an AI assistant, not a licensed financial professional.'),
  unsupportedCapabilities: z.array(z.enum(['tax', 'insurance'])).default([]),
  recommendationActions: z.array(z.string().min(1).max(2_000)).default([]),
}).strict();

type OrchestratorResponseDraft = z.infer<typeof OrchestratorResponseDraftSchema>;

export type OrchestratorTurnResult =
  | { kind: 'final'; response: OrchestratorFinalResponseV1 }
  | { kind: 'ask-user'; response: OrchestratorFinalResponseV1 };

export class OrchestratorAgent {
  private readonly teams: Map<string, TeamDefinition>;
  private readonly activeInvocation = new AsyncLocalStorage<{
    message: InboundChannelMessageV1;
    signal: AbortSignal;
    teamResults: TeamResultEnvelopeV1[];
  }>();
  readonly agent: Agent<string, ToolsInput, unknown>;
  readonly finalizerAgent: Agent<string, ToolsInput, unknown>;
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
    this.finalizerAgent = (dependencies.agentFactory ?? ((config) => new Agent(config)))({
      id: 'orchestrator-finalizer',
      name: 'Orchestrator Finalizer',
      description: 'Serializes the orchestrator answer into the final Plus One response draft.',
      instructions: finalizerInstructions,
      model: toMastraModel(dependencies.model),
      tools: {},
    });
  }

  async run(input: { message: InboundChannelMessageV1; signal?: AbortSignal }): Promise<OrchestratorFinalResponseV1> {
    const result = await this.runTurn(input);
    return result.response;
  }

  async runTurn(input: { message: InboundChannelMessageV1; signal?: AbortSignal }): Promise<OrchestratorTurnResult> {
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
          memory: {
            thread: message.conversationId,
            resource: message.householdId,
          },
        });
        if (invocation.teamResults.some((teamResult) => teamResult.status !== 'verified')) {
          return turnFromTeamResults(message, invocation.teamResults);
        }
        const direct = parseFinalResponse(result.object);
        if (direct !== undefined) return { kind: 'final', response: direct };
        return { kind: 'final', response: await this.finalizeFromModelResult(message, result.text, invocation.teamResults) };
      } catch (error) {
        if (invocation.teamResults.length === 0) throw error;
        return turnFromTeamResults(message, invocation.teamResults);
      }
    });
  }

  private async finalizeFromModelResult(
    message: InboundChannelMessageV1,
    modelText: unknown,
    teamResults: readonly TeamResultEnvelopeV1[],
  ): Promise<OrchestratorFinalResponseV1> {
    if (teamResults.some((teamResult) => teamResult.status !== 'verified')) {
      return responseFromTeamResults(message, teamResults);
    }
    try {
      const result = await this.finalizerAgent.generate([
        'InboundChannelMessageV1 context:',
        JSON.stringify(message),
        'Main orchestrator result:',
        typeof modelText === 'string' ? modelText : '',
        'Checked team results:',
        JSON.stringify(teamResults),
      ].join('\n'), {
        structuredOutput: { schema: OrchestratorResponseDraftSchema, jsonPromptInjection: true },
        toolChoice: 'none',
      });
      const draft = OrchestratorResponseDraftSchema.parse(result.object ?? parseJsonObject(result.text));
      return responseFromDraft(message, draft, teamResults);
    } catch (error) {
      if (teamResults.length === 0) throw error;
      return responseFromTeamResults(message, teamResults);
    }
  }
}

function parseFinalResponse(value: unknown): OrchestratorFinalResponseV1 | undefined {
  const parsed = OrchestratorFinalResponseSchemaV1.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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
  const teamResult = selectTeamResult(teamResults);
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

function turnFromTeamResults(
  message: InboundChannelMessageV1,
  teamResults: readonly TeamResultEnvelopeV1[],
): OrchestratorTurnResult {
  const response = responseFromTeamResults(message, teamResults);
  const teamResult = selectTeamResult(teamResults);
  if (teamResult?.status === 'insufficient_evidence') {
    return { kind: 'ask-user', response };
  }
  return { kind: 'final', response };
}

function responseFromDraft(
  message: InboundChannelMessageV1,
  draft: OrchestratorResponseDraft,
  teamResults: readonly TeamResultEnvelopeV1[] = [],
): OrchestratorFinalResponseV1 {
  const body = draft.body;
  return OrchestratorFinalResponseSchemaV1.parse({
    schemaName: 'orchestrator-final-response',
    schemaVersion: 1,
    responseId: `response_${Date.now()}`,
    householdId: message.householdId,
    conversationId: message.conversationId,
    body,
    policyBoundary: draft.policyBoundary,
    citations: citationsFromDraftOrTeamResults(draft.citations, teamResults),
    assumptions: draft.assumptions,
    freshness: draft.freshness.length === 0 ? ['current invocation only'] : draft.freshness,
    disclaimer: draft.disclaimer,
    unsupportedCapabilities: draft.unsupportedCapabilities,
    recommendationActions: draft.recommendationActions,
    delivery: {
      channel: message.channel,
      destination: destinationFor(message.channel, message.metadata.destination),
      format: message.channel === 'slack' ? 'mrkdwn' : 'plain_text',
    },
    responseHash: createHash('sha256').update(body, 'utf8').digest('hex'),
    createdAt: new Date().toISOString(),
  });
}

function citationsFromDraftOrTeamResults(
  draftCitations: OrchestratorResponseDraft['citations'],
  teamResults: readonly TeamResultEnvelopeV1[],
) {
  if (draftCitations.length > 0 && !isPolicyOnlyCitationSet(draftCitations)) {
    return draftCitations;
  }
  const teamResult = selectTeamResult(teamResults);
  if (teamResult !== undefined) return citationsFor(teamResult);
  return [{ label: 'orchestrator-policy', sourceRef: 'runtime-instructions' }];
}

function selectTeamResult(teamResults: readonly TeamResultEnvelopeV1[]): TeamResultEnvelopeV1 | undefined {
  return [...teamResults].sort((left, right) =>
    statusRank(left.status) - statusRank(right.status) || teamResults.lastIndexOf(right) - teamResults.lastIndexOf(left))[0];
}

function statusRank(status: TeamResultEnvelopeV1['status']): number {
  if (status === 'verified') return 0;
  if (status === 'partial') return 1;
  if (status === 'insufficient_evidence') return 2;
  if (status === 'conflicted') return 3;
  return 4;
}

function isPolicyOnlyCitationSet(citations: OrchestratorResponseDraft['citations']): boolean {
  return citations.every((citation) =>
    citation.artifactId === undefined
    && citation.sourceRef === 'runtime-instructions'
    && citation.label === 'orchestrator-policy');
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
