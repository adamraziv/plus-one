import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Mastra } from '@mastra/core';
import { Agent, type ToolsInput } from '@mastra/core/agent';
import { TokenLimiter } from '@mastra/core/processors';
import { ZodError } from 'zod';
import {
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  TeamResultEnvelopeSchemaV2,
  type ChannelKindV1,
  type InboundChannelMessageV1,
  type OrchestratorFinalResponseV1,
  type TeamResultEnvelopeV2,
} from '@plus-one/contracts';
import {
  createTransientModelRetryProcessor,
  getLogger,
  internalImplementationDetailMatchCategory,
  modelResultEndedOnRetry,
  ModelTemporarilyUnavailableError,
  stopAfterSemanticModelSteps,
  targetFromInboundMessage,
  type ChannelEventSink,
  type InternalImplementationDetailMatchCategory,
  type TeamDefinition,
  withLogContext,
} from '@plus-one/runtime';
import { toMastraModel, type EngineLlmModelConfig } from '../mastra/role-agent.js';
import type { OrchestratorSessionMemoryPort } from '../memory/orchestrator-session-memory.js';
import {
  internalIdentifierMatchCategory,
  type InternalIdentifierMatchCategory,
} from '../safety/internal-identifier.js';
import {
  createDelegateTeamTool,
  finalSynthesisTeamResultView,
  userFacingText,
  type OrchestratorTeamRuntime,
} from '../tools/delegate-team.js';

const orchestratorInstructions = [
  'You are the Orchestrator for a household finance agent system.',
  'You are the only user-facing entrypoint.',
  'Answer only from verified context or checked team results.',
  'An empty reporting.current_balances result does not prove that no accounts exist.',
  'Do not infer entity absence from an empty metric projection. State only that the requested metric projection returned no rows.',
  'Only reporting.accounts account-list evidence may support a claim that no accounts are configured.',
  'Answer ordinary conversation directly when no checked specialist work is needed.',
  'When checked specialist work is needed, call delegateTeam once using an exact registered team id from its team catalog.',
  'delegateTeam input must always be strict JSON, and request must be a JSON object, never a quoted JSON string.',
  'Do not refuse internal ledger capture as an external financial action; the accounting team will return a checked proposal or clarification without posting externally.',
  'Never ask the user for internal household, book, account, or other system identifiers; runtime context and team lookups own those identifiers.',
  'Never ask for, expose, repeat, quote, or include internal household, book, account, or system identifiers in any user-facing response; use user-visible names or safe clarifying questions instead.',
  'For query, pass request as query-lead-request-draft unless a full EvidenceRequestV1 is already available.',
  'When delegating query, include exact governed coverage, desiredGrain, and timeframe whenever they can be inferred from the user request.',
  'Coverage map: account lists -> account list; current balance questions -> balance snapshot; top expenses or spend by category this month -> category spend monthly; transaction-level spend history -> categorized transactions; budget vs actual -> budget variance; savings goals -> savings goal progress; debts -> debt progress; reconciliation -> reconciliation status; source sync freshness -> source freshness.',
  'Coverage labels must be copied verbatim from the coverage map as lowercase space-separated governed strings and must never be converted to underscore aliases; use "balance snapshot", never "balance_snapshot".',
  'Account existence or account inventory questions use account list coverage.',
  'Examples such as "show my accounts", "check my accounts", and "which accounts do I have" mean account list, even when phrased as a check.',
  'Use balance snapshot only when the user explicitly asks for a balance, amount, value, or net worth.',
  'Once a schema-valid EvidenceRequestV1 is delegated, treat its coverage as authoritative; do not silently substitute another reporting relation.',
  'For accounting transaction capture, pass request as AccountingLeadRequestV1 with intent transaction_capture and nested transaction-capture-request-draft JSON.',
  'In transaction-capture-request-draft.known, include user-stated amount, currency, and occurredOn; preserve user-stated account/category names as paymentAccountName and categoryName, never as internal ids.',
  'Do not execute payments, trades, tax filings, provider account changes, or external financial actions.',
  'After delegateTeam returns, explain the checked result to the user in concise natural language.',
  'Return only the user-facing reply text when you are not calling a tool.',
].join('\n');

const ORCHESTRATOR_INPUT_TOKEN_LIMIT = 24_000;
const FINAL_REPLY_FORMAT = 'mrkdwn' as const;
const MAX_ORCHESTRATOR_STEPS = 4;
const ORCHESTRATOR_MODEL_STEP_RETRIES = 2;

export type OrchestratorTurnResult =
  | { kind: 'final'; response: OrchestratorFinalResponseV1 }
  | { kind: 'ask-user'; response: OrchestratorFinalResponseV1; pendingMutation?: TeamResultEnvelopeV2 };

export type ConfirmationDecision = 'approve' | 'reject' | 'unclear';

export function confirmationDecision(body: string): ConfirmationDecision {
  const normalized = body.trim().toLowerCase().replace(/[.!]+$/g, '');
  if (/^(yes|y|ok|okay|sure|proceed|go ahead|please do|do it|sounds good|that works)$/.test(normalized)) {
    return 'approve';
  }
  if (/^(no|n|cancel|stop|never mind|nevermind)(\b|$)/.test(normalized)
    || /\b(do not|don't)\b/.test(normalized)) return 'reject';
  return 'unclear';
}

export class OrchestratorAgent {
  private readonly teams: Map<string, TeamDefinition>;
  private readonly activeInvocation = new AsyncLocalStorage<{
    message: InboundChannelMessageV1;
    signal: AbortSignal;
    teamResults: TeamResultEnvelopeV2[];
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
          kind: 'assistant.commentary',
          target: targetFromInboundMessage(input.message),
          body: delegationCommentary(input.team.team, input.request),
        }, active?.signal);
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
          const result = TeamResultEnvelopeSchemaV2.parse(
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
      resumePendingMutation: dependencies.teamRuntime.resumePendingMutation,
      cancelPendingMutation: dependencies.teamRuntime.cancelPendingMutation,
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

  async resolvePendingMutation(input: {
    message: InboundChannelMessageV1;
    pending: TeamResultEnvelopeV2;
    signal?: AbortSignal;
  }): Promise<OrchestratorTurnResult> {
    const decision = confirmationDecision(input.message.body);
    const timeoutSignal = input.signal === undefined ? createAbortTimeoutSignal(60_000) : undefined;
    const signal = input.signal ?? timeoutSignal!.signal;
    try {
      if (decision === 'approve') {
        const result = await this.dependencies.teamRuntime.resumePendingMutation({
          message: input.message,
          pending: input.pending,
          signal,
        });
        return turnFromTeamResults(input.message, [result]);
      }
      if (decision === 'reject') {
        await this.dependencies.teamRuntime.cancelPendingMutation({
          pending: input.pending,
          signal,
        });
        return {
          kind: 'final',
          response: responseFromText(input.message, "Okay, I won’t make that change."),
        };
      }
      let body = await this.synthesizeTeamResults(input.message, [input.pending], signal);
      if (!confirmationResponseIsSafe(body, input.pending)) body = confirmationFallback(input.pending);
      return turnFromTeamResults(input.message, [input.pending], body);
    } finally {
      timeoutSignal?.clear();
    }
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
      teamResults: [] as TeamResultEnvelopeV2[],
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
          let result: Awaited<ReturnType<typeof this.agent.generate>>;
          try {
            result = await abortable(this.agent.generate(prompt, {
              ...this.orchestratorGenerateOptions(message),
              stopWhen: stopAfterSemanticModelSteps(MAX_ORCHESTRATOR_STEPS),
              errorProcessors: [createTransientModelRetryProcessor({
                maxRetries: ORCHESTRATOR_MODEL_STEP_RETRIES,
              })],
              maxProcessorRetries: ORCHESTRATOR_MODEL_STEP_RETRIES,
              toolChoice: 'auto',
              prepareStep: async () => invocation.delegationCount === 0
                ? { activeTools: ['delegateTeam'], toolChoice: 'auto' as const }
                : { activeTools: [], toolChoice: 'none' as const },
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
            }), signal);
          } catch (error) {
            if (
              !signal.aborted
              && !invocation.delegationFailed
              && invocation.teamResults.length !== 0
            ) {
              return turnFromTeamResults(message, invocation.teamResults);
            }
            throw error;
          }
          if (signal.aborted) throw signal.reason ?? new DOMException('Orchestrator turn aborted.', 'AbortError');
          if (modelResultEndedOnRetry(result)) {
            if (!invocation.delegationFailed && invocation.teamResults.length !== 0) {
              return turnFromTeamResults(message, invocation.teamResults);
            }
            throw new ModelTemporarilyUnavailableError();
          }
          if (invocation.delegationFailed) {
            throw new Error('Delegated team work failed before producing a checked result.');
          }
          if (invocation.delegationCount > 0 && invocation.teamResults.length === 0) {
            throw new Error('Delegated team did not return a checked result.');
          }
          let body = finalStepResponseText(result);
          if (invocation.teamResults.length !== 0) {
            const selected = selectTeamResult(invocation.teamResults);
            const canUseInitialBody = body !== undefined
              && userFacingSafetyMatchCategory(body) === undefined
              && (selected?.effect.state === 'persisted'
                || (selected?.effect.state === 'none'
                  && (selected.status === 'verified'
                    || (selected.status === 'insufficient_evidence' && body.includes('?')))));
            if (!canUseInitialBody) {
              body = await this.synthesizeTeamResults(message, invocation.teamResults, signal);
            }
            if (selected?.effect.state === 'awaiting_confirmation'
              && !confirmationResponseIsSafe(body, selected)) {
              body = confirmationFallback(selected);
            }
            const safeBody = body !== undefined && userFacingSafetyMatchCategory(body) === undefined
              ? body
              : undefined;
            return turnFromTeamResults(message, invocation.teamResults, safeBody);
          }
          if (body === undefined) {
            throw new Error('Orchestrator returned an empty response.');
          }
          const unsafeMatchCategory = userFacingSafetyMatchCategory(body);
          if (unsafeMatchCategory !== undefined) {
            logger.warn('orchestrator.response.withheld', {
              fields: { matchCategory: unsafeMatchCategory },
            });
            body = 'I could not prepare a safe response. Please try again.';
          }
          return {
            kind: 'final',
            response: responseFromText(message, body, invocation.teamResults),
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

  private async synthesizeTeamResults(
    message: InboundChannelMessageV1,
    teamResults: readonly TeamResultEnvelopeV2[],
    signal: AbortSignal,
  ): Promise<string | undefined> {
    try {
      const result = await abortable(this.agent.generate(finalSynthesisPrompt(message, teamResults), {
        stopWhen: stopAfterSemanticModelSteps(1),
        toolChoice: 'none',
        prepareStep: async () => ({ activeTools: [], toolChoice: 'none' as const }),
        abortSignal: signal,
      }), signal);
      return finalStepResponseText(result);
    } catch (error) {
      if (signal.aborted) throw error;
      return undefined;
    }
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

function inboundContextPrompt(message: InboundChannelMessageV1): string {
  return message.body;
}

function responseFromTeamResults(
  message: InboundChannelMessageV1,
  teamResults: readonly TeamResultEnvelopeV2[],
  synthesizedBody?: string,
): OrchestratorFinalResponseV1 {
  const teamResult = selectTeamResult(teamResults);
  if (teamResult === undefined) throw new Error('Missing team result for fallback response');
  const body = synthesizedBody ?? responseBody(teamResult);
  return responseFromText(message, body, [teamResult]);
}

function turnFromTeamResults(
  message: InboundChannelMessageV1,
  teamResults: readonly TeamResultEnvelopeV2[],
  synthesizedBody?: string,
): OrchestratorTurnResult {
  const response = responseFromTeamResults(message, teamResults, synthesizedBody);
  const teamResult = selectTeamResult(teamResults);
  if (teamResult?.status === 'insufficient_evidence' || teamResult?.effect.state === 'awaiting_confirmation') {
    return teamResult.effect.state === 'awaiting_confirmation'
      ? { kind: 'ask-user', response, pendingMutation: teamResult }
      : { kind: 'ask-user', response };
  }
  return { kind: 'final', response };
}

function responseFromText(
  message: InboundChannelMessageV1,
  body: string,
  teamResults: readonly TeamResultEnvelopeV2[] = [],
): OrchestratorFinalResponseV1 {
  assertUserSafeResponseBody(body);
  const teamResult = selectTeamResult(teamResults);
  return OrchestratorFinalResponseSchemaV1.parse({
    schemaName: 'orchestrator-final-response',
    schemaVersion: 1,
    responseId: `response_${Date.now()}`,
    householdId: message.householdId,
    conversationId: message.conversationId,
    body,
    policyBoundary: teamResult === undefined ? 'informational_only' : 'personalized_finance',
    citations: teamResult === undefined
      ? [{ label: 'orchestrator-policy', sourceRef: 'runtime-instructions' }]
      : citationsFor(teamResult),
    assumptions: teamResult?.assumptions ?? [],
    freshness: teamResult === undefined
      ? ['current invocation only']
      : teamResult.freshness.length === 0 ? ['current invocation'] : teamResult.freshness,
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

function nonEmptyResponseText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const body = value.trim();
  return body.length === 0 ? undefined : body;
}

function finalStepResponseText(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  if (!Array.isArray(result.steps) || result.steps.length === 0) {
    return nonEmptyResponseText(result.text);
  }
  let lastToolStep = -1;
  for (let index = 0; index < result.steps.length; index += 1) {
    if (hasToolCalls(result.steps[index])) lastToolStep = index;
  }
  for (let index = result.steps.length - 1; index > lastToolStep; index -= 1) {
    const step = result.steps[index];
    if (hasToolCalls(step) || !isRecord(step)) continue;
    const body = nonEmptyResponseText(step.text);
    if (body !== undefined) return body;
  }
  return undefined;
}

function hasToolCalls(step: unknown): boolean {
  return isRecord(step) && Array.isArray(step.toolCalls) && step.toolCalls.length > 0;
}

function delegationCommentary(team: string, request: unknown): string {
  const coverage = isRecord(request) && Array.isArray(request.coverage)
    ? request.coverage.filter((value): value is string => typeof value === 'string')
    : [];
  if (team === 'query' && coverage.some((value) =>
    value === 'account list' || value === 'reporting.accounts')) {
    return "I'll check your household accounts.";
  }
  if (team === 'query' && coverage.some((value) =>
    value === 'categorized transactions' || value === 'reporting.categorized_transactions')) {
    return "I'll check your household transactions.";
  }
  if (team === 'query') return "I'll check your household records.";
  return "I'll check that for you.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function selectTeamResult(teamResults: readonly TeamResultEnvelopeV2[]): TeamResultEnvelopeV2 | undefined {
  return [...teamResults].sort((left, right) =>
    statusRank(left.status) - statusRank(right.status) || teamResults.lastIndexOf(right) - teamResults.lastIndexOf(left))[0];
}

function statusRank(status: TeamResultEnvelopeV2['status']): number {
  if (status === 'verified') return 0;
  if (status === 'partial') return 1;
  if (status === 'insufficient_evidence') return 2;
  if (status === 'conflicted') return 3;
  return 4;
}

function responseBody(teamResult: TeamResultEnvelopeV2): string {
  if (teamResult.status === 'insufficient_evidence') {
    const questions = clarificationQuestions(teamResult);
    return questions.length === 0
      ? 'I need a little more information before I can continue. What details can you clarify?'
      : questions.join('\n\n');
  }
  if (teamResult.status === 'verified') {
    return 'I found the requested information, but I could not safely summarize it. Please try again.';
  }
  return 'I could not complete that request safely. Please try again.';
}

function confirmationResponseIsSafe(body: string | undefined, teamResult: TeamResultEnvelopeV2): boolean {
  if (body === undefined || !body.includes('?')) return false;
  if (/\b(created|saved|added|applied|recorded|completed|succeeded)\b/i.test(body)) return false;
  const proposedChange = finalSynthesisTeamResultView(teamResult).proposedChange;
  if (proposedChange?.action !== 'create_account') return true;
  const requiredDetails = [
    proposedChange.accountName,
    proposedChange.accountingClass,
    proposedChange.normalBalance,
    proposedChange.nativeCurrency,
  ];
  return requiredDetails.every((detail) => detail !== undefined && body.toLowerCase().includes(detail.toLowerCase()));
}

function confirmationFallback(teamResult: TeamResultEnvelopeV2): string {
  const proposedChange = finalSynthesisTeamResultView(teamResult).proposedChange;
  if (proposedChange?.action === 'create_account'
    && proposedChange.accountName !== undefined
    && proposedChange.accountingClass !== undefined
    && proposedChange.normalBalance !== undefined
    && proposedChange.nativeCurrency !== undefined) {
    return `I’ll add ${proposedChange.accountName} as an ${proposedChange.nativeCurrency} ${proposedChange.accountingClass} account with a normal ${proposedChange.normalBalance} balance. Would you like me to proceed?`;
  }
  return 'I have a checked proposal ready. Would you like me to proceed?';
}

class InternalIdentifierResponseError extends Error {
  constructor(readonly matchCategory: UserFacingSafetyMatchCategory) {
    super('Final response contains internal-only detail.');
  }
}

function assertUserSafeResponseBody(body: string): void {
  const matchCategory = userFacingSafetyMatchCategory(body);
  if (matchCategory !== undefined) throw new InternalIdentifierResponseError(matchCategory);
}

type UserFacingSafetyMatchCategory =
  | InternalIdentifierMatchCategory
  | InternalImplementationDetailMatchCategory;

function userFacingSafetyMatchCategory(value: string): UserFacingSafetyMatchCategory | undefined {
  return internalIdentifierMatchCategory(value) ?? internalImplementationDetailMatchCategory(value);
}

function clarificationQuestions(teamResult: TeamResultEnvelopeV2): string[] {
  const acceptedArtifactIds = new Set(teamResult.checkerVerdicts.flatMap((verdict) =>
    verdict.verdict === 'accepted' ? [verdict.coveredArtifactId] : []));
  return teamResult.makerArtifacts.flatMap((artifact) => {
    if (!acceptedArtifactIds.has(artifact.artifactId)) return [];
    const maker = isRecord(artifact.payload) ? artifact.payload : undefined;
    const output = maker !== undefined && isRecord(maker.output) ? maker.output : undefined;
    if (output === undefined || !Array.isArray(output.questions)) return [];
    return output.questions.flatMap((question) => {
      if (typeof question !== 'string') return [];
      const safeQuestion = userFacingText(question);
      return safeQuestion === undefined ? [] : [safeQuestion];
    });
  });
}

function finalSynthesisPrompt(
  message: InboundChannelMessageV1,
  teamResults: readonly TeamResultEnvelopeV2[],
): string {
  const results = teamResults.map((result) => {
    const view = finalSynthesisTeamResultView(result);
    return {
      team: view.team,
      outcome: synthesisOutcome(view.status),
      facts: view.checkedClaims,
      assumptions: view.assumptions,
      uncertainty: view.uncertainty,
      questions: view.outstanding.filter((value) => value.includes('?')),
      data: view.checkedData,
      proposedChange: view.proposedChange,
      effectState: view.effectState,
    };
  });
  const awaitingConfirmation = results.some((result) => result.effectState === 'awaiting_confirmation');
  const confirmationRules = [
    'The checked context describes a proposed internal change that has not happened yet.',
    'Restate every supplied material detail in concise natural language.',
    'Use future tense. Ask one natural question about whether the user wants to proceed.',
    'Do not tell the user to reply with a specific word or phrase.',
    'Do not say created, saved, added, applied, recorded, completed, or succeeded in past tense.',
    'Do not invent, omit, or alter supplied proposal details.',
    'Example: create Bank ABC, asset, debit, IDR -> “I’ll add Bank ABC as an IDR asset account with a normal debit balance. Would you like me to proceed?”',
    'Example: archive Groceries -> “I’ll archive the Groceries account. Would you like me to proceed?”',
  ].join('\n');
  return [
    ...(awaitingConfirmation ? [confirmationRules] : []),
    'Write the final reply to the user using only the safe checked context below.',
    'Use concise natural language. Do not mention teams, makers, checkers, schemas, statuses, relation names, field keys, or implementation details.',
    `User request: ${message.body}`,
    `Safe checked context: ${JSON.stringify(results)}`,
    'Return only the user-facing reply text.',
  ].join('\n');
}

function synthesisOutcome(status: TeamResultEnvelopeV2['status']): string {
  if (status === 'verified') return 'checked information is ready';
  if (status === 'insufficient_evidence') return 'more information is needed from the user';
  if (status === 'partial') return 'only part of the request could be completed';
  if (status === 'conflicted') return 'the available information conflicts';
  return 'the request could not be completed';
}

function citationsFor(teamResult: TeamResultEnvelopeV2) {
  if (teamResult.claims.length === 0) {
    return [{ label: `${teamResult.team}:team-result`, sourceRef: `team-result:${teamResult.status}` }];
  }
  return teamResult.claims.map((claim) => ({
    label: `${teamResult.team}:${claim.claimId}`,
    artifactId: claim.checkedMakerArtifactIds[0]!,
  }));
}

function turnFailureCategory(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
  if (error instanceof InternalIdentifierResponseError) return `internal_${error.matchCategory}`;
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
