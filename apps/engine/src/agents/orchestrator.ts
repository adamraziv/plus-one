import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Mastra } from '@mastra/core';
import { Agent, type MastraDBMessage, type ToolsInput } from '@mastra/core/agent';
import { TokenLimiter } from '@mastra/core/processors';
import { ZodError } from 'zod';
import {
  AccountingJournalMutationProposalSchemaV1,
  ChartOfAccountsProposalSchemaV1,
} from '@plus-one/accounting';
import {
  InboundChannelMessageSchemaV1,
  MakerArtifactSchemaV1,
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
  MAX_DELEGATIONS_PER_TURN,
  userFacingText,
  type FinalSynthesisTeamResultView,
  type OrchestratorTeamRuntime,
} from '../tools/delegate-team.js';
import { requestForRuntime } from '../tools/delegate-team-schemas.js';
import type { TransactionCaptureContinuationV1 } from '../accounting/transaction-capture-continuation.js';

const orchestratorInstructions = [
  'You are the Orchestrator for a household finance agent system.',
  'You are the only user-facing entrypoint.',
  'Answer only from verified context or checked team results.',
  'An empty reporting.current_balances result does not prove that no accounts exist.',
  'Do not infer entity absence from an empty metric projection. State only that the requested metric projection returned no rows.',
  'Only reporting.accounts account-list evidence may support a claim that no accounts are configured.',
  'Answer ordinary conversation directly when no checked specialist work is needed.',
  'When checked specialist work is needed, call delegateTeam using an exact registered team id from its team catalog.',
  'Use delegateTeam as a bounded sequential tool loop: call one specialist substep, inspect its checked result, and call it again only when the same user task requires another checked substep.',
  'Do not stop after completing only a prerequisite when the original user task is still unfinished.',
  'When the current user turn both updates a transaction draft and requests a resolvable prerequisite, you MUST execute those checked substeps in that turn without returning user-facing text between them.',
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
  'For categorized transaction query rows, direction is the ledger posting direction for that exact row and account; never invert or transfer it to another account.',
  'If the user did not ask about ledger debit or credit direction, omit debit and credit wording from the reply.',
  'Account creation and chart changes always require checked specialist work; call delegateTeam instead of answering directly or collecting fields yourself.',
  'For account creation or chart changes, use the accounting team with intent chart_of_accounts and a nested chart-work-request-draft.',
  'For a new account, set action to create_account, preserve user-stated details in known, and leave missing details unresolved for the accounting team to clarify.',
  'For accounting transaction capture, pass request as AccountingLeadRequestV1 with intent transaction_capture and nested transaction-capture-request-draft JSON.',
  'In transaction-capture-request-draft.known, include user-stated amount, currency, and occurredOn; preserve user-stated account/category names as paymentAccountName and categoryName, never as internal ids.',
  'When a user uses a relative transaction date such as today, yesterday, or tomorrow, preserve that relative wording in occurredOn; do not invent an absolute date because the accounting runtime resolves it using the household timezone.',
  'When transaction capture reports that a category is unresolved, show its existing category choices and offer to add a new category. If the user chooses an existing category, delegate transaction capture with that category.',
  'A missing-category clarification is not terminal when the current user message explicitly chose to create that category. Do not repeat the category question; immediately perform the checked chart_of_accounts prerequisite in the same tool loop.',
  'If the user chooses a new category and also supplies any pending transaction details in that turn, first delegate transaction_capture with every newly supplied detail so the durable transaction draft is updated. After that checked result, delegate chart_of_accounts create_account with the requested category name and transaction currency. Use expense with normal debit for spending/outflows and income with normal credit for income/inflows. Category creation is a prerequisite of the original transaction, not a replacement task.',
  'Do not execute payments, trades, tax filings, provider account changes, or external financial actions.',
  'After delegateTeam returns, explain the checked result to the user in concise natural language.',
  'Return only the user-facing reply text when you are not calling a tool.',
].join('\n');

const ORCHESTRATOR_INPUT_TOKEN_LIMIT = 24_000;
const FINAL_REPLY_FORMAT = 'mrkdwn' as const;
const MAX_ORCHESTRATOR_STEPS = 6;
const ORCHESTRATOR_MODEL_STEP_RETRIES = 2;

export type OrchestratorTurnResult =
  | { kind: 'final'; response: OrchestratorFinalResponseV1 }
  | {
      kind: 'ask-user';
      response: OrchestratorFinalResponseV1;
      pendingMutation?: TeamResultEnvelopeV2;
      transactionContinuation?: TransactionCaptureContinuationV1;
    };

export type ConfirmationDecision = 'approve' | 'reject' | 'unclear';

export function confirmationDecision(body: string): ConfirmationDecision {
  const normalized = body.trim().toLowerCase().replace(/[^a-z0-9']+/g, ' ').trim().replace(/\s+/g, ' ');
  if (/^(?:please )?(?:no|n|cancel|stop|reject|never mind|nevermind|not now)(?:\b|$)/.test(normalized)
    || /\b(do not|don't)\b/.test(normalized)) return 'reject';
  const affirmative = '(?:yes|y|yeah|yep|yup|ok|okay|sure|absolutely|certainly|confirm|confirmed|approve|approved)';
  const action = '(?:go ahead|proceed|do it|do so|go for it)';
  if (new RegExp(`^(?:${affirmative}(?: please)?(?: (?:please )?${action})?(?: please)?|(?:please )?${action}(?: please)?|please do|sounds good|that works)$`)
    .test(normalized)) return 'approve';
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
    transactionCaptureContinuation?: TransactionCaptureContinuationV1;
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
    transactionContinuation?: TransactionCaptureContinuationV1;
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
        if (input.transactionContinuation !== undefined && isCreateTransactionCategoryProposal(input.pending)) {
          if (result.status !== 'verified' || result.effect.state !== 'persisted') {
            return turnFromTeamResults(input.message, [result], undefined, input.transactionContinuation);
          }
          const transaction = await this.continueTransactionCapture({
            message: input.message,
            pending: input.pending,
            continuation: input.transactionContinuation,
            signal,
          });
          if (transaction.status !== 'verified' || transaction.effect.state === 'unresolved') {
            return turnFromTeamResults(input.message, [result, transaction], undefined, input.transactionContinuation);
          }
          const body = categoryTransactionCompletionBody(
            input.pending,
            transaction,
            input.transactionContinuation,
          ) ?? await this.synthesizeTeamResults(input.message, [result, transaction], signal);
          return turnFromTeamResults(input.message, [result, transaction], body, input.transactionContinuation);
        }
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
      if (!confirmationResponseIsSafe(body, input.pending, input.transactionContinuation)) {
        body = confirmationFallback(input.pending, input.transactionContinuation);
      }
      return turnFromTeamResults(input.message, [input.pending], body, input.transactionContinuation);
    } catch (error) {
      if (signal.aborted) throw error;
      if (input.transactionContinuation !== undefined && isCreateTransactionCategoryProposal(input.pending)) {
        return turnFromTeamResults(
          input.message,
          [input.pending],
          'I couldn’t complete that safely yet. The category confirmation is still pending. Would you like me to retry?',
          input.transactionContinuation,
        );
      }
      throw error;
    } finally {
      timeoutSignal?.clear();
    }
  }

  private async continueTransactionCapture(input: {
    message: InboundChannelMessageV1;
    pending: TeamResultEnvelopeV2;
    continuation: TransactionCaptureContinuationV1;
    signal: AbortSignal;
  }): Promise<TeamResultEnvelopeV2> {
    const team = this.teams.get('accounting');
    if (team === undefined) throw new Error('Accounting team is not registered.');
    if (!isCreateTransactionCategoryProposal(input.pending)) {
      throw new Error('Pending mutation is not a category creation proposal.');
    }
    const proposal = ChartOfAccountsProposalSchemaV1.parse(input.pending.effect.command.payload);
    if (proposal.action !== 'create_account') {
      throw new Error('Pending category proposal is not an account creation.');
    }
    const request = {
      schemaName: 'accounting-lead-request' as const,
      schemaVersion: 1 as const,
      intent: 'transaction_capture' as const,
      request: {
        ...input.continuation.request,
        instruction: `${input.continuation.request.instruction} Use the ${proposal.name} category.`,
        known: {
          ...input.continuation.request.known,
          categoryName: proposal.name,
        },
      },
    };
    return TeamResultEnvelopeSchemaV2.parse(await this.dependencies.teamRuntime.runTeamLead({
      message: input.message,
      team,
      request: requestForRuntime(request),
      signal: input.signal,
    }));
  }

  registerMastra(mastra: Mastra): void {
    this.agent.__registerMastra(mastra);
  }

  async runTurn(input: {
    message: InboundChannelMessageV1;
    transactionContinuation?: TransactionCaptureContinuationV1;
    signal?: AbortSignal;
  }): Promise<OrchestratorTurnResult> {
    const message = InboundChannelMessageSchemaV1.parse(input.message);
    const timeoutSignal = input.signal === undefined ? createAbortTimeoutSignal(60_000) : undefined;
    const signal = input.signal ?? timeoutSignal!.signal;
    const invocation = {
      message,
      signal,
      teamResults: [] as TeamResultEnvelopeV2[],
      delegationCount: 0,
      delegationFailed: false,
      ...(input.transactionContinuation === undefined
        ? {}
        : { transactionCaptureContinuation: input.transactionContinuation }),
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
              prepareStep: async () => canDelegateAnotherSubstep(invocation)
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
              return turnFromTeamResults(message, invocation.teamResults, undefined, invocation.transactionCaptureContinuation);
            }
            throw error;
          }
          if (signal.aborted) throw signal.reason ?? new DOMException('Orchestrator turn aborted.', 'AbortError');
          if (modelResultEndedOnRetry(result)) {
            if (!invocation.delegationFailed && invocation.teamResults.length !== 0) {
              return turnFromTeamResults(message, invocation.teamResults, undefined, invocation.transactionCaptureContinuation);
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
            const canUseInitialBody = selected?.status !== 'insufficient_evidence'
              && body !== undefined
              && userFacingSafetyMatchCategory(body) === undefined
              && selected?.effect.state === 'none'
              && selected.status === 'verified';
            if (selected?.status === 'insufficient_evidence'
              || selected?.status === 'failed'
              || selected?.status === 'conflicted') {
              body = responseBody(selected);
            } else if (!canUseInitialBody) {
              body = await this.synthesizeTeamResults(message, invocation.teamResults, signal);
            }
            if (selected?.effect.state === 'awaiting_confirmation'
              && !confirmationResponseIsSafe(body, selected, invocation.transactionCaptureContinuation)) {
              body = confirmationFallback(selected, invocation.transactionCaptureContinuation);
            }
            const safeMatchCategory = body === undefined ? undefined : userFacingSafetyMatchCategory(body);
            const checkedMismatchCategory = body === undefined || selected === undefined
              ? undefined
              : checkedResponseMismatchCategory(message, body, selected);
            if (checkedMismatchCategory !== undefined) {
              logger.warn('orchestrator.checked_response.withheld', {
                fields: { matchCategory: checkedMismatchCategory },
              });
            }
            const safeBody = body !== undefined
              && safeMatchCategory === undefined
              && checkedMismatchCategory === undefined
              ? body
              : selected === undefined
                ? undefined
                : checkedResultFallback(selected);
            return turnFromTeamResults(message, invocation.teamResults, safeBody, invocation.transactionCaptureContinuation);
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
      return [dateContextMessage(message), ...(await this.dependencies.sessionMemory.prepareInput({ message }))];
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
  return `${dateContextText(message)}\n\n${message.body}`;
}

function dateContextText(message: InboundChannelMessageV1): string {
  return [
    `The inbound message timestamp is ${message.receivedAt} (UTC).`,
    'For relative transaction dates, preserve the user’s relative wording and let the accounting runtime resolve it in the household reporting timezone.',
  ].join(' ');
}

function dateContextMessage(message: InboundChannelMessageV1): MastraDBMessage {
  return {
    id: `orchestrator-date-context-${message.externalMessageId}`,
    role: 'system',
    createdAt: new Date(message.receivedAt),
    content: {
      format: 2,
      content: dateContextText(message),
      parts: [{ type: 'text', text: dateContextText(message) }],
    },
  };
}

function responseFromTeamResults(
  message: InboundChannelMessageV1,
  teamResults: readonly TeamResultEnvelopeV2[],
  synthesizedBody?: string,
  transactionContinuation?: TransactionCaptureContinuationV1,
): OrchestratorFinalResponseV1 {
  const teamResult = selectTurnTeamResult(teamResults, transactionContinuation);
  if (teamResult === undefined) throw new Error('Missing team result for fallback response');
  const body = synthesizedBody ?? responseBody(teamResult);
  return responseFromText(message, body, [teamResult]);
}

function turnFromTeamResults(
  message: InboundChannelMessageV1,
  teamResults: readonly TeamResultEnvelopeV2[],
  synthesizedBody?: string,
  transactionContinuation?: TransactionCaptureContinuationV1,
): OrchestratorTurnResult {
  const response = responseFromTeamResults(message, teamResults, synthesizedBody, transactionContinuation);
  const teamResult = selectTurnTeamResult(teamResults, transactionContinuation);
  if (teamResult?.status === 'insufficient_evidence' || teamResult?.effect.state === 'awaiting_confirmation') {
    return teamResult.effect.state === 'awaiting_confirmation'
      ? {
          kind: 'ask-user',
          response,
          pendingMutation: teamResult,
          ...(transactionContinuation === undefined ? {} : { transactionContinuation }),
        }
      : {
          kind: 'ask-user',
          response,
          ...(transactionContinuation === undefined ? {} : { transactionContinuation }),
        };
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

function selectTurnTeamResult(
  teamResults: readonly TeamResultEnvelopeV2[],
  transactionContinuation?: TransactionCaptureContinuationV1,
): TeamResultEnvelopeV2 | undefined {
  if (transactionContinuation !== undefined && teamResults.length > 1) return teamResults.at(-1);
  return selectTeamResult(teamResults);
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
      ? 'What additional details can you provide?'
      : questions.join('\n\n');
  }
  if (teamResult.status === 'verified') {
    const view = finalSynthesisTeamResultView(teamResult);
    if (view.effectState === 'persisted') {
      const change = view.proposedChange;
      if (change?.action === 'create_account'
        && change.accountName !== undefined
        && change.accountingClass !== undefined
        && change.normalBalance !== undefined
        && change.nativeCurrency !== undefined) {
        return `I added ${change.accountName} as an ${change.nativeCurrency} ${change.accountingClass} account with a normal ${change.normalBalance} balance.`;
      }
      return 'I completed the requested change and verified it.';
    }
    return 'I found the requested information, but I could not safely summarize it. Please try again.';
  }
  return 'I could not complete that request safely. Please try again.';
}

function confirmationResponseIsSafe(
  body: string | undefined,
  teamResult: TeamResultEnvelopeV2,
  transactionContinuation?: TransactionCaptureContinuationV1,
): boolean {
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
  const chartDetailsPresent = requiredDetails.every((detail) => detail !== undefined && body.toLowerCase().includes(detail.toLowerCase()));
  if (!chartDetailsPresent) return false;
  if (transactionContinuation === undefined) return true;
  const normalizedBody = body.toLowerCase();
  const known = transactionContinuation.request.known;
  const requiredTransactionDetails = [
    known.amount,
    known.currency,
    known.paymentAccountName,
    known.occurredOn,
    proposedChange.accountName,
  ].filter((detail): detail is string => detail !== undefined);
  return normalizedBody.includes('record')
    && requiredTransactionDetails.every((detail) => normalizedBody.includes(detail.toLowerCase()));
}

function canDelegateAnotherSubstep(input: {
  delegationCount: number;
  delegationFailed: boolean;
  teamResults: readonly TeamResultEnvelopeV2[];
}): boolean {
  if (input.delegationFailed || input.delegationCount >= MAX_DELEGATIONS_PER_TURN) return false;
  return !input.teamResults.some((result) =>
    result.effect.state === 'awaiting_confirmation'
    || result.effect.state === 'persisted'
    || result.effect.state === 'unresolved');
}

function confirmationFallback(
  teamResult: TeamResultEnvelopeV2,
  transactionContinuation?: TransactionCaptureContinuationV1,
): string {
  const proposedChange = finalSynthesisTeamResultView(teamResult).proposedChange;
  if (proposedChange?.action === 'create_account'
    && proposedChange.accountName !== undefined
    && proposedChange.accountingClass !== undefined
    && proposedChange.normalBalance !== undefined
    && proposedChange.nativeCurrency !== undefined) {
    if (transactionContinuation !== undefined) {
      const known = transactionContinuation.request.known;
      const transactionDetails = [
        known.amount === undefined || known.currency === undefined ? undefined : `${known.currency} ${known.amount}`,
        known.paymentAccountName === undefined
          ? undefined
          : `${proposedChange.accountingClass === 'income' ? 'into' : 'from'} ${known.paymentAccountName}`,
        known.occurredOn === undefined ? undefined : `dated ${known.occurredOn}`,
      ].filter((detail): detail is string => detail !== undefined).join(' ');
      const categoryKind = proposedChange.accountingClass === 'income'
        ? 'income category'
        : proposedChange.accountingClass === 'expense'
          ? 'spending category'
          : `${proposedChange.accountingClass} account`;
      return `I’ll add ${proposedChange.accountName} as a new ${categoryKind} in ${proposedChange.nativeCurrency}, then record ${transactionDetails} under ${proposedChange.accountName}. Would you like me to proceed?`;
    }
    return `I’ll add ${proposedChange.accountName} as an ${proposedChange.nativeCurrency} ${proposedChange.accountingClass} account with a normal ${proposedChange.normalBalance} balance. Would you like me to proceed?`;
  }
  return 'I have a checked proposal ready. Would you like me to proceed?';
}

function isCreateTransactionCategoryProposal(
  result: TeamResultEnvelopeV2,
): result is TeamResultEnvelopeV2 & {
  effect: Extract<TeamResultEnvelopeV2['effect'], { state: 'awaiting_confirmation' }>;
} {
  if (result.effect.state !== 'awaiting_confirmation') return false;
  const proposal = ChartOfAccountsProposalSchemaV1.safeParse(result.effect.command.payload);
  return proposal.success && proposal.data.action === 'create_account'
    && (proposal.data.accountingClass === 'expense' || proposal.data.accountingClass === 'income');
}

function categoryTransactionCompletionBody(
  pending: TeamResultEnvelopeV2,
  transaction: TeamResultEnvelopeV2,
  continuation: TransactionCaptureContinuationV1,
): string | undefined {
  if (!isCreateTransactionCategoryProposal(pending)
    || transaction.status !== 'verified'
    || transaction.effect.state !== 'persisted') return undefined;
  const category = ChartOfAccountsProposalSchemaV1.safeParse(pending.effect.command.payload);
  if (!category.success || category.data.action !== 'create_account') return undefined;
  const proposalArtifactId = transaction.effect.proposal.artifactId;
  const artifact = transaction.makerArtifacts.find((candidate) =>
    candidate.artifactId === proposalArtifactId);
  if (artifact === undefined) return undefined;
  const maker = MakerArtifactSchemaV1.safeParse(artifact.payload);
  if (!maker.success) return undefined;
  const proposal = AccountingJournalMutationProposalSchemaV1.safeParse(maker.data.output);
  if (!proposal.success || proposal.data.operation !== 'post') return undefined;
  const journal = proposal.data.draft.journal;
  const amount = journal.postings[0]?.transactionAmount;
  const paymentAccountName = continuation.request.known.paymentAccountName;
  if (amount === undefined || paymentAccountName === undefined) return undefined;
  const categoryKind = category.data.accountingClass === 'income' ? 'income category' : 'spending category';
  const accountPreposition = category.data.accountingClass === 'income' ? 'into' : 'from';
  return `I added ${category.data.name} as a new ${categoryKind} and recorded ${journal.transactionCurrency} ${amount} ${accountPreposition} ${paymentAccountName} on ${journal.occurredOn} under ${category.data.name}.`;
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

type CheckedResponseMismatchCategory =
  | 'query_mutation_state_conflict'
  | 'query_unrequested_posting_direction';

function checkedResponseMismatchCategory(
  message: InboundChannelMessageV1,
  body: string,
  result: TeamResultEnvelopeV2,
): CheckedResponseMismatchCategory | undefined {
  if (result.team !== 'query' || result.effect.state !== 'none') return undefined;
  if (/\bwould you like\b[\s\S]{0,160}\b(?:proceed|create|record|capture|set up)\b/i.test(body)
    || /\b(?:being|still)\s+(?:created|recorded|captured|set up)\b/i.test(body)
    || /\bproceed with\s+(?:capturing|recording|creating|setting up)\b/i.test(body)) {
    return 'query_mutation_state_conflict';
  }
  const directionRequested = /\b(?:debit(?:ed)?|credit(?:ed)?|ledger direction|posting direction)\b/i
    .test(message.body);
  const directionClaimed = /\b(?:debited|credited)\b|\b(?:debit|credit)\s+(?:posting|entry|direction)\b/i
    .test(body);
  return !directionRequested && directionClaimed
    ? 'query_unrequested_posting_direction'
    : undefined;
}

function checkedResultFallback(result: TeamResultEnvelopeV2): string | undefined {
  if (result.team !== 'query' || result.status !== 'verified' || result.effect.state !== 'none') {
    return undefined;
  }
  return categorizedTransactionFallback(finalSynthesisTeamResultView(result));
}

function categorizedTransactionFallback(view: FinalSynthesisTeamResultView): string | undefined {
  const rows = view.checkedData.flatMap((data) => data.rows);
  const categories = rows.filter((row) => {
    const accountingClass = queryRowText(row, 'accounting class');
    return accountingClass === 'expense' || accountingClass === 'income';
  });
  const descriptions = categories.flatMap((category) => {
    const amount = queryRowText(category, 'account native amount');
    const currency = queryRowText(category, 'account native currency');
    const date = queryRowText(category, 'effective on');
    const categoryName = queryRowText(category, 'account name');
    if (amount === undefined || currency === undefined || date === undefined || categoryName === undefined) return [];
    const payment = rows.find((candidate) => {
      const accountingClass = queryRowText(candidate, 'accounting class');
      return (accountingClass === 'asset' || accountingClass === 'liability')
        && queryRowText(candidate, 'effective on') === date
        && queryRowText(candidate, 'account native amount') === amount
        && queryRowText(candidate, 'account native currency') === currency
        && queryRowText(candidate, 'description') === queryRowText(category, 'description');
    });
    const paymentName = payment === undefined ? undefined : queryRowText(payment, 'account name');
    return [`${currency} ${displayDecimalAmount(amount)} transaction on ${date} under ${categoryName}${paymentName === undefined ? '' : `, using ${paymentName}`}`];
  });
  if (descriptions.length === 0) return undefined;
  if (descriptions.length === 1) return `I found a ${descriptions[0]}.`;
  return `I found these transactions:\n${descriptions.map((description) => `- ${description}`).join('\n')}`;
}

function queryRowText(
  row: Record<string, string | number | boolean | null>,
  key: string,
): string | undefined {
  const value = row[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function displayDecimalAmount(value: string): string {
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) return value;
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
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
      proposalFacts: view.proposalFacts,
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
