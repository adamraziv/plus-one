import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { Agent, type ToolsInput } from '@mastra/core/agent';
import {
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
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
  'Delegate financial read questions to the Query Team.',
  'Do not execute payments, trades, tax filings, provider account changes, or external financial actions.',
  'Return the requested OrchestratorFinalResponseV1 object.',
].join('\n');

export class OrchestratorAgent {
  private readonly teams: Map<string, TeamDefinition>;
  private readonly activeInvocation = new AsyncLocalStorage<{
    message: InboundChannelMessageV1;
    signal: AbortSignal;
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
    this.agentTools = {
      delegateTeam: createDelegateTeamTool({
        teams: this.teams,
        teamRuntime: dependencies.teamRuntime,
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
    return this.activeInvocation.run({ message, signal }, async () => {
      const prompt = [
        'InboundChannelMessageV1 context:',
        JSON.stringify(message),
      ].join('\n');
      const result = this.dependencies.model.endpoint === 'https://api.openai.com/v1'
        ? await this.agent.generate(prompt, {
          structuredOutput: { schema: OrchestratorFinalResponseSchemaV1, jsonPromptInjection: true },
        }).catch(async () => this.generatePlain(message))
        : await this.generatePlain(message);
      const candidate = result.object ?? parseJsonObject(result.text);
      const parsed = OrchestratorFinalResponseSchemaV1.safeParse(candidate);
      if (parsed.success) return parsed.data;
      return fallbackResponse(message, candidate, result.text);
    });
  }

  private async generatePlain(message: InboundChannelMessageV1): Promise<{ object?: unknown; text?: unknown }> {
    return this.agent.generate([
        'Answer the inbound message body in plain text.',
        'Do not return JSON.',
        'InboundChannelMessageV1 context:',
        JSON.stringify(message),
    ].join('\n'));
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

function fallbackResponse(message: InboundChannelMessageV1, candidate: unknown, text: unknown): OrchestratorFinalResponseV1 {
  const body = fallbackBody(candidate, text);
  const now = new Date().toISOString();
  return OrchestratorFinalResponseSchemaV1.parse({
    schemaName: 'orchestrator-final-response',
    schemaVersion: 1,
    responseId: 'response-' + createHash('sha256').update(message.externalMessageId).digest('hex').slice(0, 16),
    householdId: message.householdId,
    conversationId: message.conversationId,
    body,
    policyBoundary: fallbackPolicyBoundary(message.body),
    citations: [{ label: 'orchestrator-response', sourceRef: 'model-output' }],
    assumptions: ['Structured provider output was unavailable; response envelope was assembled by the runtime.'],
    freshness: ['current invocation'],
    disclaimer: 'Plus One is an AI assistant, not a licensed financial professional.',
    unsupportedCapabilities: [],
    recommendationActions: [],
    delivery: {
      channel: message.channel,
      destination: typeof message.metadata.destination === 'object' && message.metadata.destination !== null
        ? message.metadata.destination
        : {},
      format: message.channel === 'slack' ? 'mrkdwn' : 'plain_text',
    },
    responseHash: createHash('sha256').update(body).digest('hex'),
    createdAt: now,
  });
}

function fallbackBody(candidate: unknown, text: unknown): string {
  if (typeof candidate === 'object' && candidate !== null) {
    const record = candidate as Record<string, unknown>;
    if (typeof record.body === 'string') return record.body;
    if (typeof record.reply === 'string') return record.reply;
  }
  return typeof text === 'string' && text.trim().length > 0
    ? text.trim()
    : 'I could not produce a response.';
}

function fallbackPolicyBoundary(body: string): OrchestratorFinalResponseV1['policyBoundary'] {
  // ponytail: fallback heuristic, replace with checked classifier if unsupported-provider fallback grows.
  return /\b(execute|trade|payment|transfer|file\s+tax|buy|sell)\b/i.test(body)
    ? 'unsupported_capability'
    : 'informational_only';
}
