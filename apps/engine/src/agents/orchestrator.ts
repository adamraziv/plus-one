import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Mastra } from '@mastra/core';
import { Agent, type ToolsInput } from '@mastra/core/agent';
import { TokenLimiter } from '@mastra/core/processors';
import { ZodError, z } from 'zod';
import {
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  TeamResultEnvelopeSchemaV1,
  type ChannelKindV1,
  type InboundChannelMessageV1,
  type OrchestratorFinalResponseV1,
  type TeamResultEnvelopeV1,
} from '@plus-one/contracts';
import { getLogger, targetFromInboundMessage, type ChannelEventSink, type TeamDefinition, withLogContext } from '@plus-one/runtime';
import { toMastraModel, type EngineLlmModelConfig } from '../mastra/role-agent.js';
import type { OrchestratorSessionMemoryPort } from '../memory/orchestrator-session-memory.js';
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
  'Never ask the user for internal household, book, account, or other system identifiers; runtime context and team lookups own those identifiers.',
  'For a message like "add $10 of buying a burger", call accounting once with an object request; do not call query to discover book ids or other metadata.',
  'For query, pass request as query-lead-request-draft unless a full EvidenceRequestV1 is already available.',
  'When delegating query, include exact governed coverage, desiredGrain, and timeframe whenever they can be inferred from the user request.',
  'Coverage map: account lists -> account list; current balance questions -> balance snapshot; top expenses or spend by category this month -> category spend monthly; transaction-level spend history -> categorized transactions; budget vs actual -> budget variance; savings goals -> savings goal progress; debts -> debt progress; reconciliation -> reconciliation status; source sync freshness -> source freshness.',
  'For accounting transaction capture, pass request as AccountingLeadRequestV1 with intent transaction_capture and nested transaction-capture-request-draft JSON.',
  'In transaction-capture-request-draft.known, include user-stated amount, currency, and occurredOn; preserve user-stated account/category names as paymentAccountName and categoryName, never as internal ids.',
  'Do not execute payments, trades, tax filings, provider account changes, or external financial actions.',
  'Return the requested OrchestratorResponseDraft object.',
].join('\n');

const ORCHESTRATOR_INPUT_TOKEN_LIMIT = 24_000;
const FINAL_REPLY_FORMAT = 'mrkdwn' as const;
const MAX_ORCHESTRATOR_STEPS = 2;

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

function parseOrchestratorModelOutput(value: unknown): OrchestratorResponseDraft {
  const final = OrchestratorFinalResponseSchemaV1.safeParse(value);
  if (final.success) {
    return {
      body: final.data.body,
      policyBoundary: final.data.policyBoundary,
      citations: final.data.citations,
      assumptions: final.data.assumptions,
      freshness: final.data.freshness,
      disclaimer: final.data.disclaimer,
      unsupportedCapabilities: final.data.unsupportedCapabilities,
      recommendationActions: final.data.recommendationActions,
    };
  }
  return OrchestratorResponseDraftSchema.parse(value);
}

export type OrchestratorTurnResult =
  | { kind: 'final'; response: OrchestratorFinalResponseV1 }
  | { kind: 'ask-user'; response: OrchestratorFinalResponseV1 };

export class OrchestratorAgent {
  private readonly teams: Map<string, TeamDefinition>;
  private readonly activeInvocation = new AsyncLocalStorage<{
    message: InboundChannelMessageV1;
    signal: AbortSignal;
    teamResults: TeamResultEnvelopeV1[];
    delegationCount: number;
    delegationFailed: boolean;
    channelEvents?: ChannelEventSink;
  }>();
  readonly agent: Agent<string, ToolsInput, unknown>;
  readonly agentTools: { delegateTeam: ReturnType<typeof createDelegateTeamTool> };

  constructor(private readonly dependencies: {
    model: EngineLlmModelConfig;
    teams: readonly TeamDefinition[];
    teamRuntime: OrchestratorTeamRuntime;
    sessionMemory?: OrchestratorSessionMemoryPort;
    channelEvents?: ChannelEventSink;
    agentFactory?: (config: ConstructorParameters<typeof Agent<string, ToolsInput, unknown>>[0]) =>
      Agent<string, ToolsInput, unknown>;
  }) {
    this.teams = new Map(dependencies.teams.map((team) => [team.team, team]));
    const teamRuntime: OrchestratorTeamRuntime = {
      runTeamLead: async (input) => {
        const active = this.activeInvocation.getStore();
        const startedAt = Date.now();
        const logger = getLogger('runtime.orchestrator');
        await emitChannelEvent(active?.channelEvents, {
          kind: 'tool.started',
          target: targetFromInboundMessage(input.message),
          toolName: 'delegateTeam',
          preview: `Delegating to ${input.team.team}`,
        }, active?.signal);
        try {
          if (active?.signal.aborted) {
            throw active.signal.reason ?? new DOMException('Delegated team work aborted.', 'AbortError');
          }
          const result = TeamResultEnvelopeSchemaV1.parse(
            await abortable(dependencies.teamRuntime.runTeamLead(input), active?.signal),
          );
          if (active?.signal.aborted) {
            throw active.signal.reason ?? new DOMException('Delegated team work aborted.', 'AbortError');
          }
          active?.teamResults.push(result);
          logger.info('orchestrator.delegate.completed', {
            fields: {
              team: input.team.team,
              status: result.status,
              durationMs: Date.now() - startedAt,
            },
          });
          await emitChannelEvent(active?.channelEvents, {
            kind: 'tool.finished',
            target: targetFromInboundMessage(input.message),
            toolName: 'delegateTeam',
            ok: true,
            durationMs: Date.now() - startedAt,
          }, active?.signal);
          return result;
        } catch (error) {
          logger.warn('orchestrator.delegate.failed', {
            fields: {
              team: input.team.team,
              durationMs: Date.now() - startedAt,
            },
          });
          await emitChannelEvent(active?.channelEvents, {
            kind: 'tool.finished',
            target: targetFromInboundMessage(input.message),
            toolName: 'delegateTeam',
            ok: false,
            durationMs: Date.now() - startedAt,
          }, active?.signal);
          throw error;
        }
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
      maxRetries: 0,
      tools: this.agentTools,
      inputProcessors: [new TokenLimiter({ limit: ORCHESTRATOR_INPUT_TOKEN_LIMIT, trimMode: 'best-fit' })],
    });
  }

  async run(input: { message: InboundChannelMessageV1; signal?: AbortSignal }): Promise<OrchestratorFinalResponseV1> {
    const result = await this.runTurn(input);
    return result.response;
  }

  registerMastra(mastra: Mastra): void {
    this.agent.__registerMastra(mastra);
  }

  async runTurn(input: { message: InboundChannelMessageV1; signal?: AbortSignal }): Promise<OrchestratorTurnResult> {
    const message = InboundChannelMessageSchemaV1.parse(input.message);
    const timeoutSignal = input.signal === undefined ? createAbortTimeoutSignal(60_000) : undefined;
    const signal = input.signal ?? timeoutSignal!.signal;
    const invocation = {
      message,
      signal,
      teamResults: [] as TeamResultEnvelopeV1[],
      delegationCount: 0,
      delegationFailed: false,
      ...(this.dependencies.channelEvents === undefined ? {} : { channelEvents: this.dependencies.channelEvents }),
    };
    const logger = getLogger('runtime.orchestrator');
    return withLogContext({
      conversationId: message.conversationId,
      householdId: message.householdId,
    }, async () => {
      const startedAt = Date.now();
      logger.info('turn.started', { fields: { channel: message.channel } });
      try {
        const turn: OrchestratorTurnResult = await this.activeInvocation.run(invocation, async () => {
          const contextStartedAt = Date.now();
          if (signal.aborted) throw signal.reason ?? new DOMException('Orchestrator turn aborted.', 'AbortError');
          const prompt = await abortable(this.orchestratorInput(message), signal);
          logger.info('turn.context.prepared', {
            fields: {
              durationMs: Date.now() - contextStartedAt,
              messageCount: Array.isArray(prompt) ? prompt.length : 1,
            },
          });
          let stepOrdinal = 0;
          let stepStartedAt = Date.now();
          if (signal.aborted) throw signal.reason ?? new DOMException('Orchestrator turn aborted.', 'AbortError');
          const result = await abortable(this.agent.generate(prompt, {
            ...this.orchestratorGenerateOptions(message),
            maxSteps: MAX_ORCHESTRATOR_STEPS,
            abortSignal: signal,
            onStepFinish: (step) => {
              const usage = step.usage ?? {};
              logger.info('orchestrator.step.completed', {
                fields: {
                  step: ++stepOrdinal,
                  durationMs: Date.now() - stepStartedAt,
                  inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : 0,
                  outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : 0,
                  toolCallCount: Array.isArray(step.toolCalls) ? step.toolCalls.length : 0,
                },
              });
              stepStartedAt = Date.now();
            },
            structuredOutput: {
              schema: OrchestratorResponseDraftSchema,
            },
          }), signal);
          if (signal.aborted) throw signal.reason ?? new DOMException('Orchestrator turn aborted.', 'AbortError');
          if (invocation.delegationFailed) {
            throw new Error('Delegated team work failed before producing a checked result.');
          }
          if (invocation.delegationCount > 0 && invocation.teamResults.length === 0) {
            throw new Error('Delegated team did not return a checked result.');
          }
          const draft = parseOrchestratorModelOutput(result.object ?? parseJsonObject(result.text));
          if (invocation.teamResults.some((teamResult) => teamResult.status !== 'verified')) {
            return turnFromTeamResults(message, invocation.teamResults);
          }
          return {
            kind: 'final',
            response: responseFromDraft(message, draft, invocation.teamResults),
          };
        });
        if (signal.aborted) throw signal.reason ?? new DOMException('Orchestrator turn aborted.', 'AbortError');
        const persistence = this.dependencies.sessionMemory?.persistTurn({
          message,
          assistantText: turn.response.body,
        });
        if (persistence !== undefined) await abortable(persistence, signal);
        logger.info('turn.completed', {
          fields: { status: turn.kind, durationMs: Date.now() - startedAt },
        });
        return turn;
      } catch (error) {
        logger.warn('turn.failed', {
          fields: {
            failureCategory: turnFailureCategory(error),
            durationMs: Date.now() - startedAt,
          },
        });
        throw error;
      } finally {
        timeoutSignal?.clear();
      }
    });
  }

  private async orchestratorInput(message: InboundChannelMessageV1) {
    if (this.dependencies.sessionMemory !== undefined) {
      return await this.dependencies.sessionMemory.prepareInput({ message });
    }
    return inboundContextPrompt(message);
  }

  private orchestratorGenerateOptions(message: InboundChannelMessageV1) {
    if (this.dependencies.sessionMemory !== undefined) return {};
    return {
      memory: {
        thread: message.conversationId,
        resource: message.householdId,
      },
    };
  }
}

async function emitChannelEvent(
  sink: ChannelEventSink | undefined,
  event: Parameters<ChannelEventSink['emit']>[0],
  signal?: AbortSignal,
): Promise<void> {
  try {
    if (signal?.aborted) return;
    if (sink !== undefined) await abortable(sink.emit(event), signal);
  } catch {
    return;
  }
}

function createAbortTimeoutSignal(timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
    },
  };
}

function parseJsonObject(text: unknown): unknown {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return undefined;
  return JSON.parse(trimmed.slice(start, end + 1));
}

function inboundContextPrompt(message: InboundChannelMessageV1): string {
  return [
    'InboundChannelMessageV1 context:',
    JSON.stringify(message),
  ].join('\n');
}

function responseFromTeamResults(
  message: InboundChannelMessageV1,
  teamResults: readonly TeamResultEnvelopeV1[],
): OrchestratorFinalResponseV1 {
  const teamResult = selectTeamResult(teamResults);
  if (teamResult === undefined) throw new Error('Missing team result for fallback response');
  const body = responseBody(teamResult);
  assertUserSafeResponseBody(body);
  return OrchestratorFinalResponseSchemaV1.parse({
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
      format: FINAL_REPLY_FORMAT,
    },
    responseHash: createHash('sha256').update(body, 'utf8').digest('hex'),
    createdAt: new Date().toISOString(),
  });
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
  assertUserSafeResponseBody(body);
  return OrchestratorFinalResponseSchemaV1.parse({
    schemaName: 'orchestrator-final-response',
    schemaVersion: 1,
    responseId: `response_${Date.now()}`,
    householdId: message.householdId,
    conversationId: message.conversationId,
    body,
    policyBoundary: draft.policyBoundary,
    citations: citationsFromDraftOrTeamResults(teamResults),
    assumptions: draft.assumptions,
    freshness: freshnessFromDraftOrTeamResults(draft.freshness, teamResults),
    disclaimer: draft.disclaimer,
    unsupportedCapabilities: draft.unsupportedCapabilities,
    recommendationActions: draft.recommendationActions,
    delivery: {
      channel: message.channel,
      destination: destinationFor(message.channel, message.metadata.destination),
      format: FINAL_REPLY_FORMAT,
    },
    responseHash: createHash('sha256').update(body, 'utf8').digest('hex'),
    createdAt: new Date().toISOString(),
  });
}

function citationsFromDraftOrTeamResults(teamResults: readonly TeamResultEnvelopeV1[]) {
  const teamResult = selectTeamResult(teamResults);
  if (teamResult !== undefined) return citationsFor(teamResult);
  return [{ label: 'orchestrator-policy', sourceRef: 'runtime-instructions' }];
}

function freshnessFromDraftOrTeamResults(
  draftFreshness: OrchestratorResponseDraft['freshness'],
  teamResults: readonly TeamResultEnvelopeV1[],
): string[] {
  const teamResult = selectTeamResult(teamResults);
  if (teamResult !== undefined) return teamResult.freshness.length === 0 ? ['current invocation'] : teamResult.freshness;
  return draftFreshness.length === 0 ? ['current invocation only'] : draftFreshness;
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

function responseBody(teamResult: TeamResultEnvelopeV1): string {
  const heading = `${labelForTeam(teamResult.team)} status: ${teamResult.status}`;
  const details = [teamResult.completionReason, ...teamResult.outstanding].filter((value) => value.length > 0);
  return details.length === 0 ? heading : `${heading}\n\n${details.join('\n')}`;
}

function assertUserSafeResponseBody(body: string): void {
  if (/\b(?:household|book|account)\s*(?:id|identifier)\b/i.test(body)
    || /\b(?:hh|household|book|acct|account)_[a-z0-9_-]+\b/i.test(body)
    || /\b[hb]\d{3,}\b/i.test(body)) {
    throw new Error('Final response contains an internal identifier request.');
  }
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

function turnFailureCategory(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
  if (error instanceof ZodError) return 'schema_validation';
  return 'runtime_failure';
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) throw signal.reason ?? new DOMException('Orchestrator turn aborted.', 'AbortError');
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Orchestrator turn aborted.', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function destinationFor(channel: ChannelKindV1, destination: unknown): Record<string, unknown> {
  if (destination !== null && typeof destination === 'object' && !Array.isArray(destination)) {
    return destination as Record<string, unknown>;
  }
  return channel === 'telegram' ? { chatId: '' } : { channelId: '' };
}
