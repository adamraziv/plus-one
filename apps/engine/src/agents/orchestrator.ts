import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Mastra } from '@mastra/core';
import { Agent, type MastraDBMessage, type ToolsInput } from '@mastra/core/agent';
import { TokenLimiter } from '@mastra/core/processors';
import { RequestContext } from '@mastra/core/request-context';
import { noopObserve } from '@mastra/core/tools';
import { ZodError } from 'zod';
import { ChartOfAccountsProposalSchemaV1 } from '@plus-one/accounting';
import {
  InboundChannelMessageSchemaV1,
  OrchestratorFinalResponseSchemaV1,
  PendingWorkingMemoryMutationSchema,
  TeamResultEnvelopeSchemaV2,
  PlusOneError,
  type ChannelKindV1,
  type ErrorCategoryV1,
  type InboundChannelMessageV1,
  type OrchestratorFinalResponseV1,
  type RetryDirectiveV1,
  type TeamResultEnvelopeV2,
  type PendingWorkingMemoryMutation,
} from '@plus-one/contracts';
import {
  createTransientModelRetryProcessor,
  getLogger,
  internalImplementationDetailMatchCategory,
  isTransientModelError,
  modelResultEndedOnRetry,
  ModelTemporarilyUnavailableError,
  stopAfterSemanticModelSteps,
  targetFromInboundMessage,
  type ChannelEventSink,
  type CatalogLogger,
  type InternalImplementationDetailMatchCategory,
  type TeamDefinition,
  withLogContext,
} from '@plus-one/runtime';
import { toMastraModel, type EngineLlmModelConfig } from '../mastra/role-agent.js';
import type {
  OrchestratorSessionMemoryPort,
  WorkingMemoryMutationOperation,
  WorkingMemoryOperation,
  WorkingMemoryOperationOutcome,
} from '../memory/orchestrator-session-memory.js';
import { proposalExpired } from '../memory/working-memory-document.js';
import {
  internalIdentifierMatchCategory,
  type InternalIdentifierMatchCategory,
} from '../safety/internal-identifier.js';
import {
  createDelegateTeamTool,
  finalSynthesisTeamResultView,
  MAX_DELEGATIONS_PER_TURN,
  type OrchestratorTeamRuntime,
} from '../tools/delegate-team.js';
import { requestForRuntime } from '../tools/delegate-team-schemas.js';
import {
  createInspectWorkingMemoryTool,
  createMutateWorkingMemoryTool,
  createProposeWorkingMemoryTool,
  createViewWorkingMemoryTool,
  createReviewWorkingMemoryTool,
  type WorkingMemoryInspectionContext,
} from '../tools/working-memory.js';
import type { TransactionCaptureContinuationV1 } from '../accounting/transaction-capture-continuation.js';
import { budgetingExplicitRequestForMessage } from '../budgeting/budgeting-request.js';
import {
  createFinalResponseSubmissionSession,
  finalResponseRepairError,
  orchestratorResponseNotSubmittedError,
  SubmitFinalResponseToolId,
  type FinalResponseSubmission,
} from './orchestrator-final-response.js';
import {
  createPendingInteractionDispositionSession,
  pendingInteractionDispositionPrompt,
  SubmitPendingInteractionDispositionToolId,
} from './pending-interaction-disposition.js';

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
  'For budgeting, call delegateTeam with exactly a budgeting-lead-request containing a nested budget-plan-request-draft or budget-scenario-request-draft; for a plan use intent budget_plan and request fields instruction, scopeKey, and known, while comparisons use intent budget_scenarios and request fields instruction, scenarioCount, and known. The only budgeting intents are budget_plan and budget_scenarios, and the nested key is request.',
  'For budgeting, copy only explicit user-owned facts into request.known: priorities, timeframe start/end, targetAmount amount/currency, and category names/target amounts. Use known:{} when the user did not provide a fact; never guess values.',
  'A budgeting follow-up that supplies the requested details in phrases such as "monthly", "prepare it", "set it up", or "go ahead" is still an explicit budget request: preserve those facts and delegate immediately instead of answering directly or waiting for another confirmation.',
  'Preserve the user’s budgeting instruction and user-visible scope, and never invent household identifiers or evidence packages; the budgeting runtime owns authenticated context and checked evidence requirements.',
  'If budgeting returns a planning clarification, carry the user’s answers forward into known on the next delegation instead of repeating an empty draft.',
  'For cash-flow analysis, call delegateTeam with exactly {"team":"cash-flow","request":{"intent":"analysis","request":{"objective":"preserve the complete user objective","analysisMode":"single","timeframe":{"start":"YYYY-MM-DD","end":"YYYY-MM-DD"}}}}. Other exact cash-flow intents are obligation, savings_goal, and debt_plan. Never invent household ids or evidence packages.',
  'For investment or retirement education, use team investments-retirement with exact intent investment_education or retirement_education and nested request {"question":"preserve the complete user question"}.',
  'For checked records facts, use team records-reporting with exact intent records_facts and nested request {"focus":"preserve the complete requested scope"}.',
  'For query, call delegateTeam with exactly {"team":"query","request":{"businessQuestion":"preserve the complete finance question","coverage":["one exact governed coverage label"],"desiredGrain":["household"]}} unless a full EvidenceRequestV1 is already available. Query request is flat: do not add intent or a nested request.',
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
  'For account creation or chart changes, call delegateTeam with exactly {"team":"accounting","request":{"intent":"chart_of_accounts","request":{"action":"create_account","instruction":"preserve the complete user request","known":{"accountName":"visible name","accountingClass":"asset","normalBalance":"debit","nativeCurrency":"USD","purpose":"visible purpose"}}}}. Use the user-stated action and values; omit unknown known-fields.',
  'For a new account, set action to create_account, preserve user-stated details in known, and leave missing details unresolved for the accounting team to clarify.',
  'For accounting transaction capture, pass request as AccountingLeadRequestV1 with intent transaction_capture and nested transaction-capture-request-draft JSON.',
  'In transaction-capture-request-draft.known, include user-stated amount, currency, and occurredOn; preserve user-stated account/category names as paymentAccountName and categoryName, never as internal ids.',
  'When a user uses a relative transaction date such as today, yesterday, or tomorrow, preserve that relative wording in occurredOn; do not invent an absolute date because the accounting runtime resolves it using the household timezone.',
  'When transaction capture reports that a category is unresolved, show its existing category choices and offer to add a new category. If the user chooses an existing category, delegate transaction capture with that category.',
  'A missing-category clarification is not terminal when the current user message explicitly chose to create that category. Do not repeat the category question; immediately perform the checked chart_of_accounts prerequisite in the same tool loop.',
  'If the user chooses a new category and also supplies any pending transaction details in that turn, first delegate transaction_capture with every newly supplied detail so the durable transaction draft is updated. After that checked result, delegate chart_of_accounts create_account with the requested category name and transaction currency. Use expense with normal debit for spending/outflows and income with normal credit for income/inflows. Category creation is a prerequisite of the original transaction, not a replacement task.',
  'Do not execute payments, trades, tax filings, provider account changes, or external financial actions.',
  'After delegateTeam returns, explain the checked result to the user in concise natural language.',
  'Working Memory is durable household context, scoped to the authenticated household resource and the current conversation thread.',
  'Use Working Memory only for durable user-provided conversational context such as goals, saving preferences, names, communication preferences, and household conventions.',
  'Use proposeWorkingMemory for ordinary preference or identity signals; it creates only an invocation-local candidate and waits for the existing confirmation flow.',
  'For a correction to an existing fact, use proposeWorkingMemory with signal correction_signal and correctionTarget matching the visible summary; create one replace proposal, never delete the old entry as a substitute for replacement.',
  'An explicit remember/save request may use mutateWorkingMemory, but a candidate is never a saved fact until readback-verified approval.',
  'Use viewWorkingMemory for “what do you remember about me?” or household memory questions. It is read-only and never replaces inspection before a correction or deletion.',
  'For “forget” or “correct,” identify the visible summary through a view or inspection, then use the existing revision-gated mutation flow; never ask for an internal ID.',
  'Use reviewWorkingMemory for a deterministic read-only review. Findings are proposals only; use fresh inspection and the existing mutation flow for any accepted change.',
  'Before every create, replace, delete, or clear, call inspectWorkingMemory in this same turn.',
  'Pass the exact revision returned by inspection to mutateWorkingMemory.',
  'Use create for a new entry and an inspected entryId for replace or delete.',
  'Never invent an entryId or revision, and never provide household, thread, or principal identifiers to either tool.',
  'When confirmation is required, explain the proposed change naturally and ask for approval.',
  'Never claim a mutation succeeded unless the tool reports working_memory_mutation_succeeded.',
  'Never describe a Working Memory change as proposed, pending, or ready for approval unless a Working Memory tool returned confirmation_required in this turn.',
  'Treat authenticated principal context as internal authorization context. Never expose or ask for principal, household, thread, or other system identifiers.',
  'When an internal memory-operation event says Working Memory failed, explain the failure naturally, do not claim the information was saved or cleared, and continue with only information that remains verified.',
  'Finish every user-facing turn by calling submitFinalResponse exactly once with the complete reply body.',
  'Never return the reply as ordinary assistant text, JSON text, XML tool markup, or a fenced block.',
  'Do not call submitFinalResponse until all required domain-tool work for the turn is complete.',
  'If a submitFinalResponse call is rejected, use the rejection feedback to repair the reply and call it again.',
].join('\n');

const ORCHESTRATOR_INPUT_TOKEN_LIMIT = 24_000;
const FINAL_REPLY_FORMAT = 'mrkdwn' as const;
const MAX_ORCHESTRATOR_STEPS = 6;
const ORCHESTRATOR_MODEL_STEP_RETRIES = 2;
const ORCHESTRATOR_REQUEST_CONTEXT_KEY = 'plus-one.orchestrator' as const;

type OrchestratorMemoryFailure = {
  operation: WorkingMemoryOperation;
  status: 'failed';
  code: string;
  category: ErrorCategoryV1;
  retry: RetryDirectiveV1;
  mustReportToUser: true;
  mustNotClaimSuccess: true;
};

type OrchestratorMemoryState = {
  memoryDegraded: boolean;
  memoryFailures: OrchestratorMemoryFailure[];
};

type OrchestratorRequestContextValues = {
  [ORCHESTRATOR_REQUEST_CONTEXT_KEY]: OrchestratorMemoryState;
};

type OrchestratorRequestContext = RequestContext<OrchestratorRequestContextValues>;
type OrchestratorAgentInstance = Agent<string, ToolsInput, undefined, OrchestratorRequestContextValues>;
type OrchestratorAgentConfig = ConstructorParameters<typeof Agent<string, ToolsInput, undefined, OrchestratorRequestContextValues>>[0];

type OrchestratorInvocation = {
  message: InboundChannelMessageV1;
  signal: AbortSignal;
  requestContext: OrchestratorRequestContext;
  memoryState: OrchestratorMemoryState;
  memoryRetryUsed: boolean;
  teamResults: TeamResultEnvelopeV2[];
  memoryOutcomes: WorkingMemoryOperationOutcome[];
  memoryFailures: OrchestratorMemoryFailure[];
  delegationCount: number;
  delegationFailed: boolean;
  delegationValidationFailed: boolean;
  transactionCaptureContinuation?: TransactionCaptureContinuationV1;
  workingMemoryInspection?: WorkingMemoryInspectionContext;
  pendingWorkingMemoryMutation?: PendingWorkingMemoryMutation;
  channelEvents?: ChannelEventSink;
};

type WorkingMemorySynthesisEvent = {
  kind: 'confirmation' | 'applied' | 'rejected' | 'failed';
  operation: WorkingMemoryMutationOperation;
  summary: string;
  directive: string;
};

export type OrchestratorTurnResult =
  | { kind: 'final'; response: OrchestratorFinalResponseV1 }
  | {
      kind: 'ask-user';
      response: OrchestratorFinalResponseV1;
      pendingMutation?: TeamResultEnvelopeV2;
      pendingWorkingMemoryMutation?: PendingWorkingMemoryMutation;
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
  private readonly activeInvocation = new AsyncLocalStorage<OrchestratorInvocation>();
  readonly agent: OrchestratorAgentInstance;
  readonly agentTools: {
    delegateTeam: ReturnType<typeof createDelegateTeamTool>;
    inspectWorkingMemory?: ReturnType<typeof createInspectWorkingMemoryTool>;
    mutateWorkingMemory?: ReturnType<typeof createMutateWorkingMemoryTool>;
    proposeWorkingMemory?: ReturnType<typeof createProposeWorkingMemoryTool>;
    viewWorkingMemory?: ReturnType<typeof createViewWorkingMemoryTool>;
    reviewWorkingMemory?: ReturnType<typeof createReviewWorkingMemoryTool>;
  };

  constructor(private readonly dependencies: {
    model: EngineLlmModelConfig;
    teams: readonly TeamDefinition[];
    teamRuntime: OrchestratorTeamRuntime;
    sessionMemory?: OrchestratorSessionMemoryPort;
    channelEvents?: ChannelEventSink;
    agentFactory?: (config: OrchestratorAgentConfig) => OrchestratorAgentInstance;
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
          logger.info('orchestrator.delegation.completed', {
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
          logger.warn('orchestrator.delegation.failed', {
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
    if (dependencies.sessionMemory !== undefined) {
      this.agentTools.inspectWorkingMemory = createInspectWorkingMemoryTool({
        memory: dependencies.sessionMemory,
        getActiveInvocation: () => {
          const active = this.activeInvocation.getStore();
          if (active === undefined) return undefined;
          return {
            message: active.message,
            signal: active.signal,
            ...(active.workingMemoryInspection === undefined
              ? {}
              : { workingMemoryInspection: active.workingMemoryInspection }),
          };
        },
        recordInspection: (inspection) => {
          const active = this.activeInvocation.getStore();
          if (active !== undefined) active.workingMemoryInspection = inspection;
        },
        recordOutcome: (outcome) => this.recordMemoryOutcome(outcome),
      });
      this.agentTools.viewWorkingMemory = createViewWorkingMemoryTool({
        memory: dependencies.sessionMemory,
        getActiveInvocation: () => {
          const active = this.activeInvocation.getStore();
          if (active === undefined) return undefined;
          return {
            message: active.message,
            signal: active.signal,
            ...(active.workingMemoryInspection === undefined
              ? {}
              : { workingMemoryInspection: active.workingMemoryInspection }),
          };
        },
        recordInspection: (inspection) => {
          const active = this.activeInvocation.getStore();
          if (active !== undefined) active.workingMemoryInspection = inspection;
        },
        recordOutcome: (outcome) => this.recordMemoryOutcome(outcome),
      });
      this.agentTools.reviewWorkingMemory = createReviewWorkingMemoryTool({
        memory: dependencies.sessionMemory,
        now: () => new Date(),
        getActiveInvocation: () => {
          const active = this.activeInvocation.getStore();
          if (active === undefined) return undefined;
          return {
            message: active.message,
            signal: active.signal,
            ...(active.workingMemoryInspection === undefined
              ? {}
              : { workingMemoryInspection: active.workingMemoryInspection }),
          };
        },
        recordOutcome: (outcome) => this.recordMemoryOutcome(outcome),
      });
      this.agentTools.mutateWorkingMemory = createMutateWorkingMemoryTool({
        memory: dependencies.sessionMemory,
        now: () => new Date(),
        getActiveInvocation: () => {
          const active = this.activeInvocation.getStore();
          if (active === undefined) return undefined;
          return {
            message: active.message,
            signal: active.signal,
            ...(active.workingMemoryInspection === undefined
              ? {}
              : { workingMemoryInspection: active.workingMemoryInspection }),
          };
        },
        recordPendingMutation: (proposal) => {
          const active = this.activeInvocation.getStore();
          if (active !== undefined) active.pendingWorkingMemoryMutation = proposal;
        },
        noteSuccessfulMutation: ({ resourceId }) => dependencies.sessionMemory!.noteWorkingMemoryMutationSuccess({ resourceId }),
        recordOutcome: (outcome) => this.recordMemoryOutcome(outcome),
      });
      this.agentTools.proposeWorkingMemory = createProposeWorkingMemoryTool({
        memory: dependencies.sessionMemory,
        now: () => new Date(),
        getActiveInvocation: () => {
          const active = this.activeInvocation.getStore();
          if (active === undefined) return undefined;
          return {
            message: active.message,
            signal: active.signal,
            ...(active.workingMemoryInspection === undefined
              ? {}
              : { workingMemoryInspection: active.workingMemoryInspection }),
          };
        },
        recordPendingMutation: (proposal) => {
          const active = this.activeInvocation.getStore();
          if (active !== undefined) active.pendingWorkingMemoryMutation = proposal;
        },
        recordOutcome: (outcome) => this.recordMemoryOutcome(outcome),
      });
    }
    const agentConfig: OrchestratorAgentConfig = {
      id: 'orchestrator',
      name: 'Orchestrator',
      description: 'The single entrypoint agent that responds to users and delegates specialized work to team leads.',
      instructions: orchestratorInstructions,
      model: toMastraModel(dependencies.model) as OrchestratorAgentConfig['model'],
      maxRetries: 0,
      tools: this.agentTools,
      inputProcessors: [new TokenLimiter({ limit: ORCHESTRATOR_INPUT_TOKEN_LIMIT, trimMode: 'best-fit' })],
    };
    if (dependencies.sessionMemory !== undefined) {
      agentConfig.memory = ({ requestContext }) => {
        const memoryState = requestContext.get(ORCHESTRATOR_REQUEST_CONTEXT_KEY);
        return memoryState?.memoryDegraded
          ? dependencies.sessionMemory!.degradedAgentMemory ?? dependencies.sessionMemory!.agentMemory
          : dependencies.sessionMemory!.agentMemory;
      };
    }
    this.agent = (dependencies.agentFactory ?? ((config) => new Agent(config)))(agentConfig);
  }

  async classifyPendingWorkingMemoryInput(input: {
    message: InboundChannelMessageV1;
    pending: PendingWorkingMemoryMutation;
    signal?: AbortSignal;
  }): Promise<'approve' | 'reject' | 'new_intent' | 'ambiguous'> {
    const direct = confirmationDecision(input.message.body);
    if (direct !== 'unclear') return direct;
    if (/\b(?:but|instead|change|except)\b/i.test(input.message.body)) return 'ambiguous';

    const session = createPendingInteractionDispositionSession();
    const signal = input.signal ?? AbortSignal.timeout(60_000);
    await this.agent.generate(pendingInteractionDispositionPrompt(input), {
      tools: { [SubmitPendingInteractionDispositionToolId]: session.tool },
      activeTools: [SubmitPendingInteractionDispositionToolId],
      toolChoice: {
        type: 'tool' as const,
        toolName: SubmitPendingInteractionDispositionToolId,
      },
      prepareStep: async () => ({
        tools: { [SubmitPendingInteractionDispositionToolId]: session.tool },
        activeTools: [SubmitPendingInteractionDispositionToolId],
        toolChoice: {
          type: 'tool' as const,
          toolName: SubmitPendingInteractionDispositionToolId,
        },
      }),
      abortSignal: signal,
    } as never);
    return session.requireDisposition();
  }

  async run(input: { message: InboundChannelMessageV1; signal?: AbortSignal }): Promise<OrchestratorFinalResponseV1> {
    const result = await this.runTurn(input);
    return result.response;
  }

  async runScheduledWorkingMemoryReview(input: {
    message: InboundChannelMessageV1;
  }): Promise<OrchestratorFinalResponseV1> {
    const memory = this.dependencies.sessionMemory;
    if (memory === undefined) return responseFromTrustedBody(input.message, 'I could not review saved context right now.');
    const result = await memory.reviewWorkingMemory({
      threadId: input.message.conversationId,
      resourceId: input.message.householdId,
      principalRef: input.message.speaker.principalRef,
      requestedBy: 'scheduled_review',
      now: new Date(),
    });
    if (result.status === 'failed') return responseFromTrustedBody(input.message, 'I could not complete the saved-context review right now.');
    const body = result.report.findings.length === 0
      ? 'I checked the household’s saved context and found nothing that needs attention. No changes were made.'
      : `I found ${result.report.findings.length} saved-context item${result.report.findings.length === 1 ? '' : 's'} that may need your review. Nothing was changed.`;
    return responseFromTrustedBody(input.message, body);
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
            const body = await this.synthesizeTeamResults(
              input.message,
              [result],
              signal,
              (submittedBody) => this.assertTeamResultResponse(
                input.message,
                [result],
                submittedBody,
                input.transactionContinuation,
              ),
            );
            return turnFromTeamResults(input.message, [result], body, input.transactionContinuation);
          }
          const transaction = await this.continueTransactionCapture({
            message: input.message,
            pending: input.pending,
            continuation: input.transactionContinuation,
            signal,
          });
          if (transaction.status !== 'verified' || transaction.effect.state === 'unresolved') {
            const body = await this.synthesizeTeamResults(
              input.message,
              [result, transaction],
              signal,
              (submittedBody) => this.assertTeamResultResponse(
                input.message,
                [result, transaction],
                submittedBody,
                input.transactionContinuation,
              ),
            );
            return turnFromTeamResults(input.message, [result, transaction], body, input.transactionContinuation);
          }
          const body = await this.synthesizeTeamResults(
            input.message,
            [result, transaction],
            signal,
            (submittedBody) => this.assertTeamResultResponse(
              input.message,
              [result, transaction],
              submittedBody,
              input.transactionContinuation,
            ),
          );
          return turnFromTeamResults(input.message, [result, transaction], body, input.transactionContinuation);
        }
        const body = await this.synthesizeTeamResults(input.message, [result], signal);
        return turnFromTeamResults(input.message, [result], body);
      }
      if (decision === 'reject') {
        await this.dependencies.teamRuntime.cancelPendingMutation({
          pending: input.pending,
          signal,
        });
        return {
          kind: 'final',
          response: responseFromTrustedBody(input.message, "Okay, I won’t make that change."),
        };
      }
      const body = await this.synthesizeTeamResults(
        input.message,
        [input.pending],
        signal,
        (submittedBody) => this.assertTeamResultResponse(
          input.message,
          [input.pending],
          submittedBody,
          input.transactionContinuation,
        ),
      );
      return turnFromTeamResults(input.message, [input.pending], body, input.transactionContinuation);
    } catch (error) {
      if (signal.aborted) throw error;
      if (input.transactionContinuation !== undefined && isCreateTransactionCategoryProposal(input.pending)) {
        const body = await this.synthesizeTeamResults(
          input.message,
          [input.pending],
          signal,
          (submittedBody) => this.assertTeamResultResponse(
            input.message,
            [input.pending],
            submittedBody,
            input.transactionContinuation,
          ),
        );
        return turnFromTeamResults(input.message, [input.pending], body, input.transactionContinuation);
      }
      throw error;
    } finally {
      timeoutSignal?.clear();
    }
  }

  async resolvePendingWorkingMemoryMutation(input: {
    message: InboundChannelMessageV1;
    pending: PendingWorkingMemoryMutation;
    transactionContinuation?: TransactionCaptureContinuationV1;
    signal?: AbortSignal;
  }): Promise<OrchestratorTurnResult> {
    void input.transactionContinuation;
    const pending = PendingWorkingMemoryMutationSchema.parse(input.pending);
    const timeoutSignal = input.signal === undefined ? createAbortTimeoutSignal(60_000) : undefined;
    const signal = input.signal ?? timeoutSignal!.signal;
    try {
      if (pending.householdId !== input.message.householdId
        || pending.conversationId !== input.message.conversationId
        || pending.speakerPrincipalRef !== input.message.speaker.principalRef) {
        throw new PlusOneError({
          category: 'validation_rejected',
          code: 'working_memory_pending_mismatch',
          message: 'Working Memory proposal does not match the authenticated conversation.',
          retry: 'never',
          receiptLookupRequired: false,
        });
      }

      if (proposalExpired(pending.expiresAt, new Date())) {
        const response = await this.synthesizeWorkingMemoryOutcome({
          message: input.message,
          event: workingMemoryEvent(pending, 'failed', 'The proposal expired before it was approved.'),
          signal,
        });
        return { kind: 'final', response };
      }

      const decision = confirmationDecision(input.message.body);
      if (decision === 'reject') {
        const response = await this.synthesizeWorkingMemoryOutcome({
          message: input.message,
          event: workingMemoryEvent(pending, 'rejected', 'Do not make this change.'),
          signal,
        });
        return { kind: 'final', response };
      }
      if (decision === 'unclear') {
        const response = await this.synthesizeWorkingMemoryOutcome({
          message: input.message,
          event: workingMemoryConfirmationEvent(pending),
          signal,
        });
        return {
          kind: 'ask-user',
          response,
          pendingWorkingMemoryMutation: pending,
        };
      }

      const memory = this.dependencies.sessionMemory;
      if (memory === undefined) {
        const response = await this.synthesizeWorkingMemoryOutcome({
          message: input.message,
          event: workingMemoryEvent(pending, 'failed', 'The change could not be stored.'),
          signal,
        });
        return { kind: 'final', response };
      }
      const applied = await memory.applyWorkingMemoryMutation({
        threadId: input.message.conversationId,
        resourceId: input.message.householdId,
        principalRef: input.message.speaker.principalRef,
        basedOnRevision: pending.basedOnRevision,
        mutation: pending.mutation,
      });
      if (applied.status === 'failed') {
        const directive = applied.code === 'working_memory_revision_stale'
          ? 'The context changed before approval. Do not say the change was completed; ask the user to request a fresh review.'
          : 'Do not say the change was completed because storage did not verify it.';
        const response = await this.synthesizeWorkingMemoryOutcome({
          message: input.message,
          event: workingMemoryEvent(pending, 'failed', directive),
          signal,
        });
        return { kind: 'final', response };
      }
      const reviewDue = memory.noteWorkingMemoryMutationSuccess({ resourceId: input.message.householdId }).reviewDue;
      if (reviewDue) {
        await memory.reviewWorkingMemory({
          threadId: input.message.conversationId,
          resourceId: input.message.householdId,
          principalRef: input.message.speaker.principalRef,
          requestedBy: 'user',
          now: new Date(),
        });
      }
      const response = await this.synthesizeWorkingMemoryOutcome({
        message: input.message,
        event: workingMemoryEvent(pending, 'applied', 'Confirm that the change was verified and completed.'),
        signal,
      });
      return { kind: 'final', response };
    } finally {
      timeoutSignal?.clear();
    }
  }

  private async synthesizeWorkingMemoryOutcome(input: {
    message: InboundChannelMessageV1;
    event: WorkingMemorySynthesisEvent;
    signal: AbortSignal;
  }): Promise<OrchestratorFinalResponseV1> {
    const active = this.activeInvocation.getStore();
    const body = await this.generateSubmittedResponse({
      prompt: workingMemorySynthesisPrompt(input.message, input.event, undefined),
      message: input.message,
      signal: input.signal,
      ...(active?.requestContext === undefined ? {} : { requestContext: active.requestContext }),
      validateBody: (submittedBody) => {
        assertUserSafeResponseBody(submittedBody);
        if (!workingMemorySynthesisResponseIsSafe(submittedBody, input.event)) {
          throw rejectedResponseError('Follow the Working Memory outcome: do not claim success for a failed or declined change, and ask for approval when required.');
        }
      },
    });
    return responseFromTrustedBody(input.message, body);
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
    const memoryState: OrchestratorMemoryState = {
      memoryDegraded: false,
      memoryFailures: [],
    };
    const requestContext = new RequestContext<OrchestratorRequestContextValues>();
    requestContext.set(ORCHESTRATOR_REQUEST_CONTEXT_KEY, memoryState);
    const invocation: OrchestratorInvocation = {
      message,
      signal,
      requestContext,
      memoryState,
      memoryRetryUsed: false,
      teamResults: [] as TeamResultEnvelopeV2[],
      memoryOutcomes: [],
      memoryFailures: memoryState.memoryFailures,
      delegationCount: 0,
      delegationFailed: false,
      delegationValidationFailed: false,
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
          const prompt = await abortable(this.orchestratorInput(message, invocation), signal);
          logger.info('turn.context.prepared', {
            fields: {
              durationMs: Date.now() - contextStartedAt,
              messageCount: Array.isArray(prompt) ? prompt.length : 1,
            },
          });
          const deterministicBudgetRequest = budgetingExplicitRequestForMessage(message);
          if (deterministicBudgetRequest !== undefined) {
            try {
              const executeDelegateTeam = this.agentTools.delegateTeam.execute;
              if (executeDelegateTeam === undefined) {
                throw new Error('The delegateTeam tool is not executable.');
              }
              const runtimeBudgetRequest = requestForRuntime(deterministicBudgetRequest);
              if (runtimeBudgetRequest === null
                || typeof runtimeBudgetRequest !== 'object'
                || Array.isArray(runtimeBudgetRequest)) {
                throw new Error('The deterministic budgeting request must be a JSON object.');
              }
              await executeDelegateTeam({
                team: 'budgeting',
                request: runtimeBudgetRequest,
              }, {
                abortSignal: signal,
                requestContext: new RequestContext(),
                observe: noopObserve,
              });
            } catch (error) {
              if (signal.aborted) throw error;
              return delegationFailureTurn(message);
            }
            const body = await this.synthesizeTeamResults(
              message,
              invocation.teamResults,
              signal,
              (submittedBody) => this.assertSubmittedResponse(message, invocation, submittedBody),
            );
            return turnFromTeamResults(message, invocation.teamResults, body, invocation.transactionCaptureContinuation);
          }
          let stepOrdinal = 0;
          let stepStartedAt = Date.now();
          if (signal.aborted) throw signal.reason ?? new DOMException('Orchestrator turn aborted.', 'AbortError');
          let generated: Awaited<ReturnType<typeof this.generateOrchestratorTurn>>;
          try {
            generated = await abortable(this.generateOrchestratorTurn(prompt, message, invocation, signal, {
              nextStep: () => ++stepOrdinal,
              getStepStartedAt: () => stepStartedAt,
              setStepStartedAt: (value) => { stepStartedAt = value; },
              logger,
            }), signal);
          } catch (error) {
            if (!signal.aborted && isWorkingMemoryFailure(error) && !invocation.memoryRetryUsed) {
              invocation.memoryRetryUsed = true;
              this.recordMemoryOutcome(memoryOutcomeFromError(error));
              const retryPrompt = await abortable(this.orchestratorInput(message, invocation), signal);
              try {
                generated = await abortable(this.generateOrchestratorTurn(retryPrompt, message, invocation, signal, {
                  nextStep: () => ++stepOrdinal,
                  getStepStartedAt: () => stepStartedAt,
                  setStepStartedAt: (value) => { stepStartedAt = value; },
                  logger,
                }), signal);
              } catch (retryError) {
                if (isWorkingMemoryFailure(retryError)) this.recordMemoryOutcome(memoryOutcomeFromError(retryError));
                throw retryError;
              }
            } else {
              if (isWorkingMemoryFailure(error)) this.recordMemoryOutcome(memoryOutcomeFromError(error));
              if (error instanceof PlusOneError && error.code === 'orchestrator_response_not_submitted') {
                throw error;
              }
              if (!signal.aborted && isTransientModelError(error)) {
                throw error;
              }
              if (!signal.aborted && invocation.teamResults.length !== 0) {
                const body = await this.synthesizeTeamResults(
                  message,
                  invocation.teamResults,
                  signal,
                  (submittedBody) => this.assertSubmittedResponse(message, invocation, submittedBody),
                );
                return turnFromTeamResults(message, invocation.teamResults, body, invocation.transactionCaptureContinuation);
              }
              if (!signal.aborted && invocation.delegationFailed) {
                return delegationFailureTurn(message);
              }
              throw error;
            }
          }
          if (signal.aborted) throw signal.reason ?? new DOMException('Orchestrator turn aborted.', 'AbortError');
          if (modelResultEndedOnRetry(generated.result)) {
            throw new ModelTemporarilyUnavailableError();
          }
          if (invocation.delegationFailed && invocation.teamResults.length === 0) {
            return delegationFailureTurn(message);
          }
          if (invocation.delegationCount > 0 && invocation.teamResults.length === 0) {
            return delegationFailureTurn(message);
          }
          if (invocation.pendingWorkingMemoryMutation !== undefined) {
            const response = await this.synthesizeWorkingMemoryOutcome({
              message,
              event: workingMemoryConfirmationEvent(invocation.pendingWorkingMemoryMutation),
              signal,
            });
            return {
              kind: 'ask-user',
              response,
              pendingWorkingMemoryMutation: invocation.pendingWorkingMemoryMutation,
            };
          }
          const body = generated.submission.body;
          if (invocation.teamResults.length !== 0) {
            return turnFromTeamResults(message, invocation.teamResults, body, invocation.transactionCaptureContinuation);
          }
          if (invocation.memoryFailures.length !== 0) {
            const memorySafeBody = await this.ensureMemoryFailureResponse(message, body, invocation, signal);
            return {
              kind: 'final',
              response: responseFromTrustedBody(message, memorySafeBody, invocation.teamResults),
            };
          }
          return {
            kind: 'final',
            response: responseFromTrustedBody(message, body, invocation.teamResults),
          };
        });
        if (signal.aborted) throw signal.reason ?? new DOMException('Orchestrator turn aborted.', 'AbortError');
        logger.info('turn.completed', {
          fields: { status: turn.kind, durationMs: Date.now() - startedAt },
        });
        return turn;
      } catch (error) {
        logger.error('turn.failed', {
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

  private recordMemoryOutcome(outcome: WorkingMemoryOperationOutcome): void {
    const active = this.activeInvocation.getStore();
    if (active === undefined) return;
    active.memoryOutcomes.push(outcome);
    if (outcome.status !== 'failed') return;
    const failure = memoryFailureFromOutcome(outcome);
    active.memoryFailures.push(failure);
    active.memoryState.memoryDegraded = true;
  }

  private assertSubmittedResponse(
    message: InboundChannelMessageV1,
    invocation: OrchestratorInvocation,
    body: string,
  ): void {
    this.assertTeamResultResponse(
      message,
      invocation.teamResults,
      body,
      invocation.transactionCaptureContinuation,
    );
    if (invocation.memoryFailures.length !== 0 && !memoryFailureResponseIsSafe(body)) {
      throw rejectedResponseError('Explain that the Working Memory operation failed and do not claim that it succeeded.');
    }
  }

  private assertTeamResultResponse(
    message: InboundChannelMessageV1,
    teamResults: readonly TeamResultEnvelopeV2[],
    body: string,
    transactionContinuation?: TransactionCaptureContinuationV1,
  ): void {
    if (userFacingSafetyMatchCategory(body) !== undefined) {
      throw rejectedResponseError('Do not expose internal implementation details or identifiers in the reply.');
    }
    assertUserSafeResponseBody(body);
    const selected = selectTeamResult(teamResults);
    if (selected === undefined) return;
    if (checkedResponseMismatchCategory(message, body, selected) !== undefined) {
      throw rejectedResponseError('Keep the reply consistent with the checked result and the user request.');
    }
    if (selected.effect.state === 'awaiting_confirmation'
      && !confirmationResponseIsSafe(body, selected, transactionContinuation)) {
      throw rejectedResponseError('Describe the proposed change accurately and ask whether the user wants to proceed; do not claim it already happened.');
    }
  }

  private async generateOrchestratorTurn(
    prompt: string | MastraDBMessage[],
    message: InboundChannelMessageV1,
    invocation: OrchestratorInvocation,
    signal: AbortSignal,
    input: {
      nextStep(): number;
      getStepStartedAt(): number;
      setStepStartedAt(value: number): void;
      logger: CatalogLogger<'runtime.orchestrator'>;
    },
  ): Promise<{
    result: Awaited<ReturnType<OrchestratorAgentInstance['generate']>>;
    submission: FinalResponseSubmission;
  }> {
    const responseSession = createFinalResponseSubmissionSession({
      validateBody: (body) => this.assertSubmittedResponse(message, invocation, body),
    });
    const stopAtStepLimit = stopAfterSemanticModelSteps(MAX_ORCHESTRATOR_STEPS);
    const generationOptions = {
      ...this.orchestratorGenerateOptions(message, invocation.requestContext),
      outputProcessors: [responseSession.outputProcessor],
      stopWhen: ({ steps }: { steps: readonly unknown[] }) =>
        responseSession.hasSubmission()
        || stopAtStepLimit({ steps }),
      errorProcessors: [createTransientModelRetryProcessor({
        maxRetries: ORCHESTRATOR_MODEL_STEP_RETRIES,
      })],
      maxProcessorRetries: ORCHESTRATOR_MODEL_STEP_RETRIES,
      toolChoice: 'auto',
      prepareStep: async () => {
        const activeTools = this.orchestratorToolNames(invocation);
        return {
          tools: {
            ...Object.fromEntries(Object.entries(this.agentTools).filter(([, tool]) => tool !== undefined)),
            [SubmitFinalResponseToolId]: responseSession.tool,
          },
          activeTools: [...activeTools, SubmitFinalResponseToolId],
          toolChoice: 'auto' as const,
        };
      },
      abortSignal: signal,
      onStepFinish: (step: {
        usage?: { inputTokens?: number; outputTokens?: number };
        toolCalls?: unknown[];
      }) => {
        const usage = step.usage ?? {};
        input.logger.debug('orchestrator.step.completed', {
          fields: {
            step: input.nextStep(),
            durationMs: Date.now() - input.getStepStartedAt(),
            inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : 0,
            outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : 0,
            toolCallCount: Array.isArray(step.toolCalls) ? step.toolCalls.length : 0,
          },
        });
        input.setStepStartedAt(Date.now());
      },
    };
    try {
      const result = await this.agent.generate(prompt, {
        ...generationOptions,
        abortSignal: signal,
      } as never);
      return { result, submission: responseSession.requireSubmission() };
    } catch (error) {
      if (responseSession.protocolViolationObserved() && isResponseProtocolTripWire(error)) {
        throw orchestratorResponseNotSubmittedError();
      }
      throw error;
    }
  }

  private orchestratorToolNames(invocation: OrchestratorInvocation): string[] {
    const names: string[] = [];
    if (this.dependencies.sessionMemory !== undefined && !invocation.memoryState.memoryDegraded) {
      if (this.agentTools.inspectWorkingMemory !== undefined) names.push('inspectWorkingMemory');
      if (this.agentTools.mutateWorkingMemory !== undefined) names.push('mutateWorkingMemory');
      if (this.agentTools.proposeWorkingMemory !== undefined) names.push('proposeWorkingMemory');
      if (this.agentTools.viewWorkingMemory !== undefined) names.push('viewWorkingMemory');
      if (this.agentTools.reviewWorkingMemory !== undefined) names.push('reviewWorkingMemory');
    }
    if (canDelegateAnotherSubstep(invocation)) names.unshift('delegateTeam');
    return names;
  }

  private async generateSubmittedResponse(input: {
    prompt: string | MastraDBMessage[];
    message: InboundChannelMessageV1;
    signal: AbortSignal;
    requestContext?: OrchestratorRequestContext;
    validateBody(body: string): void;
  }): Promise<string> {
    const responseSession = createFinalResponseSubmissionSession({
      validateBody: input.validateBody,
    });
    const stopAtResponseLimit = stopAfterSemanticModelSteps(2);
    try {
      await abortable(this.agent.generate(input.prompt, {
        ...this.orchestratorGenerateOptions(input.message, input.requestContext),
        outputProcessors: [responseSession.outputProcessor],
        stopWhen: ({ steps }: { steps: readonly unknown[] }) =>
          responseSession.hasSubmission() || stopAtResponseLimit({ steps }),
        maxProcessorRetries: ORCHESTRATOR_MODEL_STEP_RETRIES,
        prepareStep: async () => ({
          tools: { [SubmitFinalResponseToolId]: responseSession.tool },
          activeTools: [SubmitFinalResponseToolId],
          toolChoice: { type: 'tool' as const, toolName: SubmitFinalResponseToolId },
        }),
        toolChoice: { type: 'tool' as const, toolName: SubmitFinalResponseToolId },
        abortSignal: input.signal,
      } as never), input.signal);
      return responseSession.requireSubmission().body;
    } catch (error) {
      if (responseSession.protocolViolationObserved() && isResponseProtocolTripWire(error)) {
        throw orchestratorResponseNotSubmittedError();
      }
      throw error;
    }
  }

  private async ensureMemoryFailureResponse(
    message: InboundChannelMessageV1,
    candidate: string | undefined,
    invocation: OrchestratorInvocation,
    signal: AbortSignal,
  ): Promise<string> {
    if (memoryFailureResponseIsSafe(candidate)) return candidate!;
    return this.generateSubmittedResponse({
      prompt: memoryFailureSynthesisPrompt(message, invocation.memoryFailures, undefined),
      message,
      signal,
      requestContext: invocation.requestContext,
      validateBody: (body) => {
        assertUserSafeResponseBody(body);
        if (!memoryFailureResponseIsSafe(body)) {
          throw rejectedResponseError('Explain that the Working Memory operation failed and do not claim that it succeeded.');
        }
      },
    });
  }

  private async orchestratorInput(message: InboundChannelMessageV1, invocation?: OrchestratorInvocation) {
    if (this.dependencies.sessionMemory !== undefined) {
      let durableWorkingMemory: MastraDBMessage[] = [];
      if (invocation !== undefined && !invocation.memoryState.memoryDegraded) {
        const context = await this.dependencies.sessionMemory.readWorkingMemoryPromptContext({
          threadId: message.conversationId,
          resourceId: message.householdId,
          principalRef: message.speaker.principalRef,
        });
        this.recordMemoryOutcome(context.outcome);
        if (context.status === 'succeeded') {
          durableWorkingMemory = [durableWorkingMemoryMessage(message, context.context.prompt)];
        }
      }
      return [
        dateContextMessage(message),
        authenticatedPrincipalMessage(message),
        ...durableWorkingMemory,
        ...(invocation === undefined ? [] : memoryFailureMessages(invocation.memoryFailures)),
        userMessage(message),
      ];
    }
    return inboundContextPrompt(message);
  }

  private orchestratorGenerateOptions(message: InboundChannelMessageV1, requestContext?: OrchestratorRequestContext) {
    const memoryDegraded = requestContext?.get(ORCHESTRATOR_REQUEST_CONTEXT_KEY)?.memoryDegraded === true;
    return {
      memory: {
        thread: message.conversationId,
        resource: message.householdId,
        ...(!memoryDegraded ? {
          options: {
            workingMemory: { enabled: false as const },
          },
        } : {}),
        ...(memoryDegraded ? {
          options: {
            readOnly: true as const,
            lastMessages: false as const,
            semanticRecall: false as const,
            observationalMemory: false as const,
            workingMemory: { enabled: false as const },
          },
        } : {}),
      },
      ...(requestContext === undefined ? {} : { requestContext }),
    };
  }

  private async synthesizeTeamResults(
    message: InboundChannelMessageV1,
    teamResults: readonly TeamResultEnvelopeV2[],
    signal: AbortSignal,
    validateBody?: (body: string) => void,
  ): Promise<string> {
    const active = this.activeInvocation.getStore();
    return this.generateSubmittedResponse({
      prompt: finalSynthesisPrompt(message, teamResults),
      message,
      signal,
      ...(active?.requestContext === undefined ? {} : { requestContext: active.requestContext }),
      validateBody: validateBody ?? ((body) => this.assertTeamResultResponse(message, teamResults, body)),
    });
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

function durableWorkingMemoryMessage(message: InboundChannelMessageV1, prompt: string): MastraDBMessage {
  return {
    id: `orchestrator-durable-working-memory-${message.externalMessageId}`,
    role: 'system',
    createdAt: new Date(message.receivedAt),
    content: {
      format: 2,
      content: prompt,
      parts: [{ type: 'text', text: prompt }],
    },
  };
}

function authenticatedPrincipalMessage(message: InboundChannelMessageV1): MastraDBMessage {
  const displayName = message.speaker.displayName === undefined
    ? 'not provided'
    : message.speaker.displayName;
  const content = [
    `Authenticated speaker principal reference: ${message.speaker.principalRef}.`,
    `Authenticated speaker display name: ${displayName}.`,
    'Use this only to scope member Working Memory updates. Never include the principal reference in a user-facing response.',
  ].join(' ');
  return {
    id: `orchestrator-principal-context-${message.externalMessageId}`,
    role: 'system',
    createdAt: new Date(message.receivedAt),
    content: {
      format: 2,
      content,
      parts: [{ type: 'text', text: content }],
    },
  };
}

function userMessage(message: InboundChannelMessageV1): MastraDBMessage {
  return {
    id: message.externalMessageId,
    role: 'user',
    createdAt: new Date(message.receivedAt),
    threadId: message.conversationId,
    resourceId: message.householdId,
    content: {
      format: 2,
      content: message.body,
      parts: [{ type: 'text', text: message.body }],
    },
  };
}

function memoryFailureMessages(failures: readonly OrchestratorMemoryFailure[]): MastraDBMessage[] {
  return failures.map((failure, index) => {
    const content = [
      'Internal operation event. Do not quote these fields or expose implementation details.',
      `Working Memory operation failed: ${JSON.stringify(failure)}.`,
      'Explain the failure naturally if it affects the user request. Do not claim that the failed operation succeeded.',
    ].join(' ');
    return {
      id: `orchestrator-working-memory-failure-${index}`,
      role: 'system',
      createdAt: new Date(),
      content: {
        format: 2,
        content,
        parts: [{ type: 'text', text: content }],
      },
    };
  });
}

function memoryFailureSynthesisPrompt(
  message: InboundChannelMessageV1,
  failures: readonly OrchestratorMemoryFailure[],
  candidate: string | undefined,
): string {
  return [
    dateContextText(message),
    `User request: ${message.body}`,
    `Internal Working Memory outcomes: ${JSON.stringify(failures)}`,
    candidate === undefined ? '' : `Draft response to revise: ${candidate}`,
    'Return only a concise user-facing response. Explain what could not be completed, do not claim the failed save or clear succeeded, and continue with verified information. Do not mention internal codes, schemas, tools, or identifiers.',
  ].filter((part) => part.length > 0).join('\n\n');
}

function memoryFailureResponseIsSafe(value: string | undefined): value is string {
  if (value === undefined || !memoryFailureAcknowledges(value) || memoryFailureClaimsSuccess(value)) return false;
  return userFacingSafetyMatchCategory(value) === undefined;
}

function workingMemoryConfirmationEvent(
  pending: PendingWorkingMemoryMutation,
): WorkingMemorySynthesisEvent {
  return workingMemoryEvent(
    pending,
    'confirmation',
    'Explain the proposed change and ask the user to approve or decline it. Do not say it has been completed.',
  );
}

function workingMemoryEvent(
  pending: PendingWorkingMemoryMutation,
  kind: WorkingMemorySynthesisEvent['kind'],
  directive: string,
): WorkingMemorySynthesisEvent {
  return {
    kind,
    operation: pending.mutation.operation,
    summary: workingMemoryMutationSummary(pending),
    directive,
  };
}

function workingMemoryMutationSummary(pending: PendingWorkingMemoryMutation): string {
  const mutation = pending.mutation;
  if (mutation.operation === 'clear') return 'all Working Memory';
  if (mutation.operation === 'delete') return 'the selected Working Memory entry';
  return mutation.entry.summary.replace(/\b(?:wme|wmproposal)_[A-Za-z0-9_-]+\b/gi, 'the selected entry');
}

function workingMemorySynthesisPrompt(
  message: InboundChannelMessageV1,
  event: WorkingMemorySynthesisEvent,
  candidate: string | undefined,
): string {
  return [
    dateContextText(message),
    `User message: ${message.body}`,
    `Working Memory operation: ${event.operation}`,
    `Safe change summary: ${event.summary}`,
    `Required response behavior: ${event.directive}`,
    candidate === undefined ? '' : `Draft response to revise: ${candidate}`,
    'Return only a concise, natural user-facing response. For a completed change, say it is saved, stored, updated, or otherwise in place. For a declined change, say that no change was made. For a failed change, say it was not completed. Never mention tools, schemas, revisions, proposal IDs, entry IDs, principals, households, conversations, or internal codes.',
  ].filter((part) => part.length > 0).join('\n\n');
}

function workingMemorySynthesisResponseIsSafe(
  value: string | undefined,
  event: WorkingMemorySynthesisEvent,
): value is string {
  if (value === undefined || userFacingSafetyMatchCategory(value) !== undefined) return false;
  if (event.kind === 'confirmation') {
    return value.includes('?') && !workingMemoryClaimsSuccess(value) && !workingMemoryClaimsFailure(value);
  }
  if (event.kind === 'applied') {
    return value.trim().length > 0 && !workingMemoryClaimsFailure(value);
  }
  if (event.kind === 'rejected') {
    return value.trim().length > 0 && !workingMemoryClaimsSuccess(value);
  }
  return workingMemoryClaimsFailure(value) && !workingMemoryClaimsSuccess(value);
}

function workingMemoryClaimsFailure(value: string): boolean {
  return /\b(?:couldn['’]t|could not|unable to|wasn['’]t able|was not able|failed|failure|expired|stale|changed|no changes?|nothing changed|changes? were not made|left .* unchanged|kept .* unchanged|not completed|not complete|didn['’]t|did not|didn['’]t go through|did not go through|cannot|can['’]t|won['’]t|will not|not make|not applied|not stored|not saved|not updated)\b/i.test(value);
}

function workingMemoryClaimsSuccess(value: string): boolean {
  if (workingMemoryClaimsFailure(value)) return false;
  return memoryFailureClaimsSuccess(value)
    || /\b(?:saved|stored|updated|remembered|applied|cleared|completed|complete|done|set|in place|all set|taken care of|in (?:your )?memory)\b/i.test(value);
}

function memoryFailureAcknowledges(value: string): boolean {
  return /\b(?:couldn['’]t|could not|unable to|wasn['’]t able|was not able|failed|failure|not available|unavailable|didn['’]t|did not|cannot|can['’]t|without)\b/i.test(value);
}

function memoryFailureClaimsSuccess(value: string): boolean {
  return /\b(?:I|we|Plus One|the system)\s+(?:have\s+|has\s+|did\s+)?(?:saved|remembered|stored|cleared|forgotten|updated|persisted)\b/i.test(value)
    || /\b(?:is|was|has been)\s+(?:now\s+)?(?:saved|remembered|stored|cleared|forgotten|updated|persisted)\b/i.test(value);
}

function isWorkingMemoryFailure(error: unknown): boolean {
  return (error instanceof PlusOneError
    && (/^working_memory_/.test(error.code) || /^observational_memory_/.test(error.code)))
    || (error instanceof Error && /input processor error/i.test(error.message));
}

function memoryOperationFromCode(code: string): WorkingMemoryOperation {
  if (/clear/i.test(code)) return 'clear';
  if (/update|write/i.test(code)) return 'update';
  if (/observation/i.test(code)) return 'observation';
  return 'read';
}

function memoryOutcomeFromError(
  error: unknown,
  operation?: WorkingMemoryOperation,
): WorkingMemoryOperationOutcome {
  if (error instanceof PlusOneError) {
    return {
      operation: operation ?? memoryOperationFromCode(error.code),
      status: 'failed',
      code: error.code,
      category: error.category,
      retry: error.retry,
    };
  }
  return failedWorkingMemoryOutcome(
    operation ?? 'read',
    `working_memory_${operation ?? 'read'}_failed`,
    'runtime_failure',
    'after_backoff',
  );
}

function failedWorkingMemoryOutcome(
  operation: WorkingMemoryOperation,
  code: string,
  category: ErrorCategoryV1,
  retry: RetryDirectiveV1,
): WorkingMemoryOperationOutcome {
  return { operation, status: 'failed', code, category, retry };
}

function memoryFailureFromOutcome(outcome: WorkingMemoryOperationOutcome): OrchestratorMemoryFailure {
  return {
    operation: outcome.operation,
    status: 'failed',
    code: outcome.code,
    category: outcome.category ?? 'runtime_failure',
    retry: outcome.retry ?? 'after_backoff',
    mustReportToUser: true,
    mustNotClaimSuccess: true,
  };
}

function responseFromTeamResults(
  message: InboundChannelMessageV1,
  teamResults: readonly TeamResultEnvelopeV2[],
  synthesizedBody: string,
  transactionContinuation?: TransactionCaptureContinuationV1,
): OrchestratorFinalResponseV1 {
  const teamResult = selectTurnTeamResult(teamResults, transactionContinuation);
  if (teamResult === undefined) throw new Error('Missing team result for response envelope.');
  return responseFromTrustedBody(message, synthesizedBody, [teamResult]);
}

function turnFromTeamResults(
  message: InboundChannelMessageV1,
  teamResults: readonly TeamResultEnvelopeV2[],
  synthesizedBody: string,
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

function delegationFailureTurn(message: InboundChannelMessageV1): OrchestratorTurnResult {
  return {
    kind: 'final',
    response: responseFromTrustedBody(
      message,
      'I could not complete the specialist check, so I cannot give you a checked answer yet. '
        + 'No changes were made. Please try again.',
    ),
  };
}

function responseFromTrustedBody(
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

function rejectedResponseError(message: string): PlusOneError {
  return finalResponseRepairError(message);
}

function isResponseProtocolTripWire(error: unknown): boolean {
  if (!isRecord(error) || error.processorId !== 'orchestrator-final-response-protocol') return false;
  return isRecord(error.options) && error.options.retry === true;
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
  transactionCaptureContinuation?: TransactionCaptureContinuationV1;
}): boolean {
  if (input.delegationFailed || input.delegationCount >= MAX_DELEGATIONS_PER_TURN) return false;
  return !input.teamResults.some((result) =>
    result.status === 'failed'
    || result.status === 'conflicted'
    || (result.status === 'insufficient_evidence'
      && input.transactionCaptureContinuation === undefined)
    || result.effect.state === 'awaiting_confirmation'
    || result.effect.state === 'persisted'
    || result.effect.state === 'unresolved');
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
