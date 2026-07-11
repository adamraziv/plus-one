import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Mastra } from '@mastra/core';
import { Agent, type MastraDBMessage, type ToolsInput } from '@mastra/core/agent';
import { TokenLimiter } from '@mastra/core/processors';
import { ZodError, z } from 'zod';
import {
  CurrencyCodeSchema,
  InboundChannelMessageSchemaV1,
  JsonValueSchema,
  OrchestratorFinalResponseSchemaV1,
  type ChannelKindV1,
  type InboundChannelMessageV1,
  type JsonValue,
  type OrchestratorFinalResponseV1,
  type TeamResultEnvelopeV1,
} from '@plus-one/contracts';
import { getLogger, targetFromInboundMessage, type ChannelEventSink, type TeamDefinition, withLogContext } from '@plus-one/runtime';
import { toMastraModel, type EngineLlmModelConfig } from '../mastra/role-agent.js';
import type { OrchestratorSessionMemoryPort } from '../memory/orchestrator-session-memory.js';
import { QueryLeadRequestDraftSchemaV1 } from '../tools/delegate-team-schemas.js';
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
  'When delegating query, include exact governed coverage, desiredGrain, and timeframe whenever they can be inferred from the user request.',
  'Coverage map: account lists -> account list; current balance questions -> balance snapshot; top expenses or spend by category this month -> category spend monthly; transaction-level spend history -> categorized transactions; budget vs actual -> budget variance; savings goals -> savings goal progress; debts -> debt progress; reconciliation -> reconciliation status; source sync freshness -> source freshness.',
  'For accounting transaction capture, pass request as AccountingLeadRequestV1 with intent transaction_capture and nested transaction-capture-request-draft JSON.',
  'In transaction-capture-request-draft.known, include user-stated amount, currency, and occurredOn; preserve user-stated account/category names as paymentAccountName and categoryName, never as internal ids.',
  'Do not execute payments, trades, tax filings, provider account changes, or external financial actions.',
  'Return the requested OrchestratorFinalResponseV1 object.',
].join('\n');

const ORCHESTRATOR_INPUT_TOKEN_LIMIT = 24_000;
const FINAL_REPLY_FORMAT = 'mrkdwn' as const;

const finalizerInstructions = [
  'You serialize the Orchestrator final answer for Plus One.',
  'Use only the supplied inbound message, main orchestrator result, and checked team results.',
  'Do not call tools.',
  'Do not invent checked facts, citations, timestamps, ids, hashes, account data, or transaction confirmations.',
  'If the main result says more information is needed, preserve that in body.',
  'Return only the requested structured draft object.',
].join('\n');

const accountingIntentInstructions = [
  'You classify only explicit Plus One internal ledger transaction-capture requests.',
  'Assume the user is speaking about Plus One internal ledger work unless they explicitly ask for an external payment, trade, tax filing, provider login, or provider account change.',
  'Return shouldDelegateTransactionCapture true when the user asks to record, add, capture, or log a purchase, spend, or expense in Plus One accounting records.',
  'Return shouldDelegateJournal true with journalOperation transfer when the user asks to transfer money between their own accounts inside Plus One.',
  'Return shouldDelegateTransactionCapture true even when account, category, or date details are incomplete; the downstream accounting team will ask clarifying questions.',
  'Return false for read questions, capability questions, external payments, trades, tax filings, provider account changes, or unclear chit-chat.',
  'When true, preserve the original instruction and extract only user-stated amount, currency, occurredOn date, paymentAccountName, and categoryName.',
  'When the latest user message answers a prior clarification, merge it with earlier user-stated transaction details from the same conversation.',
  'Assistant messages may explain what the user is clarifying, but only user messages may supply amount, currency, paymentAccountName, occurredOn, or categoryName values.',
  'Do not invent internal account ids or category ids.',
  'Never answer the user, refuse access, or mention security limitations. Only classify the intent into the requested JSON object.',
  'Return only the requested structured object.',
].join('\n');

const queryIntentInstructions = [
  'You classify only read-only Plus One household finance questions.',
  'Assume the user is asking about Plus One household data inside this app unless they explicitly ask to log in, connect a bank, fetch external provider data, or perform an external action.',
  'Return shouldDelegateQuery true for questions asking to inspect internal Plus One balances, accounts, expenses, budgets, transactions, goals, debts, reconciliation, or source freshness.',
  'Return false for accounting writes, external payments, trades, tax filings, provider account changes, general capabilities, or unclear chit-chat.',
  'When true, preserve the user question as businessQuestion and extract only semantic timeframe, desiredGrain, requiredCalculations, and coverage.',
  'Coverage map: account list -> account list; current balance -> balance snapshot; top expenses or spend by category this month -> category spend monthly; transaction-level expense history -> categorized transactions; budget vs actual -> budget variance; savings goals -> savings goal progress; debt payoff or liability status -> debt progress; reconciliation -> reconciliation status; source freshness -> source freshness.',
  'For category spend monthly, desiredGrain should be household, month, category and requiredCalculations should usually stay empty because the governed report is already aggregated.',
  'If shouldDelegateQuery is true, coverage must not be empty.',
  'Do not invent account ids, transaction ids, balances, or facts.',
  'Never answer the user, refuse access, or mention security limitations. Only classify the intent into the requested JSON object.',
  'Return only the requested structured object.',
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

const AccountingIntentDraftSchema = z.object({
  shouldDelegateTransactionCapture: z.boolean(),
  shouldDelegateJournal: z.boolean().default(false),
  journalOperation: z.enum(['transfer']).optional(),
  instruction: z.string().min(1).max(4_000).optional(),
  known: z.object({
    amount: z.string().min(1).max(128).optional(),
    currency: CurrencyCodeSchema.optional(),
    paymentAccountName: z.string().min(1).max(512).optional(),
    occurredOn: z.string().min(1).max(64).optional(),
    categoryName: z.string().min(1).max(512).optional(),
  }).strict().default({}),
}).strict();

type AccountingIntentDraft = z.infer<typeof AccountingIntentDraftSchema>;

const QueryIntentDraftSchema = z.object({
  shouldDelegateQuery: z.boolean(),
  businessQuestion: z.string().min(1).max(2_000).optional(),
  timeframe: z.object({
    start: z.string().min(1).max(64),
    end: z.string().min(1).max(64),
  }).strict().optional(),
  desiredGrain: z.array(z.string().min(1).max(128)).max(16).default([]),
  requiredCalculations: z.array(z.string().min(1).max(512)).max(32).default([]),
  coverage: z.array(z.string().min(1).max(512)).max(32).default([]),
}).strict();

const accountingIntentJsonContract = [
  'Return only one JSON object.',
  'Schema:',
  '{"shouldDelegateTransactionCapture":boolean,"shouldDelegateJournal":boolean,"journalOperation":"transfer?","instruction":"string?","known":{"amount":"string?","currency":"USD?","paymentAccountName":"string?","occurredOn":"YYYY-MM-DD?","categoryName":"string?"}}',
  'Example input: "Add $10 buying a burger"',
  'Example output: {"shouldDelegateTransactionCapture":true,"shouldDelegateJournal":false,"instruction":"Add $10 buying a burger","known":{"amount":"10.00","currency":"USD"}}',
  'Example input: "Record a USD 10.00 burger purchase from checking on 2026-06-27 in dining out."',
  'Example output: {"shouldDelegateTransactionCapture":true,"shouldDelegateJournal":false,"instruction":"Record a USD 10.00 burger purchase from checking on 2026-06-27 in dining out.","known":{"amount":"10.00","currency":"USD","paymentAccountName":"checking","occurredOn":"2026-06-27","categoryName":"dining out"}}',
  'Example input: "transfer $1000 from my savings to my checking account"',
  'Example output: {"shouldDelegateTransactionCapture":false,"shouldDelegateJournal":true,"journalOperation":"transfer","instruction":"transfer $1000 from my savings to my checking account","known":{}}',
  'If the message is not an internal Plus One ledger capture request, return {"shouldDelegateTransactionCapture":false,"shouldDelegateJournal":false,"known":{}}.',
].join('\n');

const queryIntentJsonContract = [
  'Return only one JSON object.',
  'Schema:',
  '{"shouldDelegateQuery":boolean,"businessQuestion":"string?","timeframe":{"start":"YYYY-MM-DD","end":"YYYY-MM-DD"}?,"desiredGrain":["string"],"requiredCalculations":["string"],"coverage":["string"]}',
  'Coverage map:',
  '- account list -> ["account list"] with desiredGrain ["household","account"]',
  '- current bank/account balance -> ["balance snapshot"] with desiredGrain ["household","account"]',
  '- top expenses or spend by category this month -> ["category spend monthly"] with desiredGrain ["household","month","category"]',
  '- transaction history or categorized spend rows -> ["categorized transactions"]',
  '- budget vs actual -> ["budget variance"]',
  '- savings goals -> ["savings goal progress"]',
  '- debt or liabilities -> ["debt progress"]',
  '- reconciliation -> ["reconciliation status"]',
  '- source sync freshness -> ["source freshness"]',
  'Example input: "What is my current bank account balance?"',
  'Example output: {"shouldDelegateQuery":true,"businessQuestion":"What is my current bank account balance?","desiredGrain":["household","account"],"requiredCalculations":[],"coverage":["balance snapshot"]}',
  'Example input: "What are my top expenses this month?"',
  'Example output: {"shouldDelegateQuery":true,"businessQuestion":"What are my top expenses this month?","timeframe":{"start":"2026-06-01","end":"2026-06-30"},"desiredGrain":["household","month","category"],"requiredCalculations":[],"coverage":["category spend monthly"]}',
  'If the message is not an internal Plus One read query, return {"shouldDelegateQuery":false,"desiredGrain":[],"requiredCalculations":[],"coverage":[]}.',
].join('\n');

export type OrchestratorTurnResult =
  | { kind: 'final'; response: OrchestratorFinalResponseV1 }
  | { kind: 'ask-user'; response: OrchestratorFinalResponseV1 };

export class OrchestratorAgent {
  private readonly teams: Map<string, TeamDefinition>;
  private readonly teamRuntime: OrchestratorTeamRuntime;
  private readonly activeInvocation = new AsyncLocalStorage<{
    message: InboundChannelMessageV1;
    signal: AbortSignal;
    teamResults: TeamResultEnvelopeV1[];
    channelEvents?: ChannelEventSink;
  }>();
  readonly agent: Agent<string, ToolsInput, unknown>;
  readonly finalizerAgent: Agent<string, ToolsInput, unknown>;
  readonly accountingIntentAgent: Agent<string, ToolsInput, unknown>;
  readonly queryIntentAgent: Agent<string, ToolsInput, unknown>;
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
        const request = input.team.team === 'query'
          ? await this.refineQueryRequest(input.message, input.request)
          : input.request;
        const active = this.activeInvocation.getStore();
        const startedAt = Date.now();
        await emitChannelEvent(active?.channelEvents, {
          kind: 'tool.started',
          target: targetFromInboundMessage(input.message),
          toolName: 'delegateTeam',
          preview: `Delegating to ${input.team.team}`,
        });
        try {
          const result = await dependencies.teamRuntime.runTeamLead({ ...input, request });
          active?.teamResults.push(result);
          await emitChannelEvent(active?.channelEvents, {
            kind: 'tool.finished',
            target: targetFromInboundMessage(input.message),
            toolName: 'delegateTeam',
            ok: true,
            durationMs: Date.now() - startedAt,
          });
          return result;
        } catch (error) {
          await emitChannelEvent(active?.channelEvents, {
            kind: 'tool.finished',
            target: targetFromInboundMessage(input.message),
            toolName: 'delegateTeam',
            ok: false,
            durationMs: Date.now() - startedAt,
          });
          throw error;
        }
      },
    };
    this.teamRuntime = teamRuntime;
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
      inputProcessors: [new TokenLimiter({ limit: ORCHESTRATOR_INPUT_TOKEN_LIMIT, trimMode: 'best-fit' })],
    });
    this.accountingIntentAgent = (dependencies.agentFactory ?? ((config) => new Agent(config)))({
      id: 'orchestrator-accounting-intent',
      name: 'Orchestrator Accounting Intent',
      description: 'Classifies explicit internal transaction capture requests into a typed accounting draft.',
      instructions: accountingIntentInstructions,
      model: toMastraModel(dependencies.model),
      tools: {},
    });
    this.queryIntentAgent = (dependencies.agentFactory ?? ((config) => new Agent(config)))({
      id: 'orchestrator-query-intent',
      name: 'Orchestrator Query Intent',
      description: 'Classifies internal read-only finance questions into a typed query draft.',
      instructions: queryIntentInstructions,
      model: toMastraModel(dependencies.model),
      tools: {},
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

  registerMastra(mastra: Mastra): void {
    this.agent.__registerMastra(mastra);
    this.finalizerAgent.__registerMastra(mastra);
    this.accountingIntentAgent.__registerMastra(mastra);
    this.queryIntentAgent.__registerMastra(mastra);
  }

  async runTurn(input: { message: InboundChannelMessageV1; signal?: AbortSignal }): Promise<OrchestratorTurnResult> {
    const message = InboundChannelMessageSchemaV1.parse(input.message);
    const timeoutSignal = input.signal === undefined ? createAbortTimeoutSignal(60_000) : undefined;
    const signal = input.signal ?? timeoutSignal!.signal;
    const invocation = {
      message,
      signal,
      teamResults: [] as TeamResultEnvelopeV1[],
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
          const prompt = await this.orchestratorInput(message);
          const accountingIntentPrompt = accountingIntentPromptFromOrchestratorInput(message, prompt);
          const queryIntentPrompt = intentPromptFromOrchestratorInput(prompt);
          try {
            const result = await this.agent.generate(prompt, this.orchestratorGenerateOptions(message));
            if (invocation.teamResults.some((teamResult) => teamResult.status !== 'verified')) {
              return turnFromTeamResults(message, invocation.teamResults);
            }
            if (invocation.teamResults.length === 0) {
              const accountingRequest = await this.accountingRequestFromIntent(message, accountingIntentPrompt);
              if (accountingRequest !== undefined) {
                await this.delegateTeam(message, 'accounting', accountingRequest, signal);
                return turnFromTeamResults(message, invocation.teamResults);
              }
              const queryRequest = await this.queryRequestFromIntent(message, queryIntentPrompt);
              if (queryRequest !== undefined) {
                await this.delegateTeam(message, 'query', queryRequest, signal);
                if (invocation.teamResults.some((teamResult) => teamResult.status !== 'verified')) {
                  return turnFromTeamResults(message, invocation.teamResults);
                }
                const direct = parseFinalResponse(result.object);
                return {
                  kind: 'final',
                  response: await this.finalizeFromModelResult(message, direct?.body ?? result.text, invocation.teamResults),
                };
              }
            }
            const direct = parseFinalResponse(result.object);
            if (direct !== undefined) return { kind: 'final', response: normalizeFinalResponseDelivery(message, direct) };
            return { kind: 'final', response: await this.finalizeFromModelResult(message, result.text, invocation.teamResults) };
          } catch (error) {
            if (invocation.teamResults.length === 0) throw error;
            return turnFromTeamResults(message, invocation.teamResults);
          }
        });
        await this.dependencies.sessionMemory?.persistTurn({
          message,
          assistantText: turn.response.body,
        });
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

  private async delegateTeam(
    message: InboundChannelMessageV1,
    teamId: string,
    request: JsonValue,
    signal: AbortSignal,
  ): Promise<void> {
    const team = this.teams.get(teamId);
    if (team === undefined) throw new Error(`Unknown team: ${teamId}`);
    await this.teamRuntime.runTeamLead({ message, team, request, signal });
  }

  private async accountingRequestFromIntent(
    message: InboundChannelMessageV1,
    prompt = inboundContextPrompt(message),
  ): Promise<JsonValue | undefined> {
    try {
      const intent = await generateTypedDraft({
        agent: this.accountingIntentAgent,
        schema: AccountingIntentDraftSchema,
        prompt,
        fallbackJsonContract: accountingIntentJsonContract,
      });
      if (intent.shouldDelegateJournal && intent.journalOperation === 'transfer') {
        return JsonValueSchema.parse({
          schemaName: 'accounting-lead-request',
          schemaVersion: 1,
          intent: 'journal',
          request: {
            operation: 'transfer',
            instruction: intent.instruction ?? message.body,
          },
        });
      }
      if (!intent.shouldDelegateTransactionCapture) return undefined;
      return JsonValueSchema.parse({
        schemaName: 'accounting-lead-request',
        schemaVersion: 1,
        intent: 'transaction_capture',
        request: {
          schemaName: 'transaction-capture-request-draft',
          schemaVersion: 1,
          instruction: intent.instruction ?? message.body,
          known: transactionKnownFromIntent(intent.known),
        },
      });
    } catch {
      return undefined;
    }
  }

  private async queryRequestFromIntent(
    message: InboundChannelMessageV1,
    prompt = inboundContextPrompt(message),
  ): Promise<JsonValue | undefined> {
    try {
      const intent = await generateTypedDraft({
        agent: this.queryIntentAgent,
        schema: QueryIntentDraftSchema,
        prompt,
        fallbackJsonContract: queryIntentJsonContract,
      });
      if (!intent.shouldDelegateQuery || intent.businessQuestion === undefined || intent.coverage.length === 0) {
        return undefined;
      }
      return JsonValueSchema.parse({
        schemaName: 'query-lead-request-draft',
        schemaVersion: 1,
        businessQuestion: intent.businessQuestion,
        ...(intent.timeframe === undefined ? {} : { timeframe: intent.timeframe }),
        ...(intent.desiredGrain.length === 0 ? {} : { desiredGrain: intent.desiredGrain }),
        requiredCalculations: intent.requiredCalculations,
        coverage: intent.coverage,
      });
    } catch {
      return undefined;
    }
  }

  private async refineQueryRequest(
    message: InboundChannelMessageV1,
    request: JsonValue,
  ): Promise<JsonValue> {
    const draft = QueryLeadRequestDraftSchemaV1.safeParse(request);
    if (!draft.success || !isUnderspecifiedQueryDraft(draft.data)) return request;
    return await this.queryRequestFromIntent(message) ?? request;
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

async function emitChannelEvent(
  sink: ChannelEventSink | undefined,
  event: Parameters<ChannelEventSink['emit']>[0],
): Promise<void> {
  try {
    await sink?.emit(event);
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

function isUnderspecifiedQueryDraft(
  draft: z.infer<typeof QueryLeadRequestDraftSchemaV1>,
): boolean {
  return draft.coverage === undefined || draft.coverage.length === 0
    || draft.desiredGrain === undefined || draft.desiredGrain.length === 0;
}

function inboundContextPrompt(message: InboundChannelMessageV1): string {
  return [
    'InboundChannelMessageV1 context:',
    JSON.stringify(message),
  ].join('\n');
}

function intentPromptFromOrchestratorInput(prompt: string | MastraDBMessage[]): string {
  if (typeof prompt === 'string') return prompt;
  return prompt
    .map((message) => `${message.role}: ${messageText(message)}`)
    .join('\n\n');
}

function accountingIntentPromptFromOrchestratorInput(
  message: InboundChannelMessageV1,
  prompt: string | MastraDBMessage[],
): string {
  if (typeof prompt === 'string') {
    return [
      'Conversation transcript before the latest inbound message:',
      '(none)',
      'Latest inbound message JSON:',
      JSON.stringify(message),
      'When the latest user message answers a prior clarification, merge it with earlier user-stated transaction details from the same conversation.',
      'Only carry forward amount, currency, paymentAccountName, occurredOn, and categoryName when the user stated them somewhere in the conversation.',
      'Ignore assistant-authored missing-field labels or guesses; use assistant messages only to understand what the user is clarifying.',
    ].join('\n\n');
  }
  const priorMessages = prompt.slice(0, -1);
  return [
    'Conversation transcript before the latest inbound message:',
    priorMessages.length === 0 ? '(none)' : priorMessages.map((entry) => `${entry.role}: ${messageText(entry)}`).join('\n\n'),
    'Latest inbound message JSON:',
    JSON.stringify(message),
    'When the latest user message answers a prior clarification, merge it with earlier user-stated transaction details from the same conversation.',
    'Only carry forward amount, currency, paymentAccountName, occurredOn, and categoryName when the user stated them somewhere in the conversation.',
    'Ignore assistant-authored missing-field labels or guesses; use assistant messages only to understand what the user is clarifying.',
  ].join('\n\n');
}

function messageText(message: MastraDBMessage): string {
  return message.content.parts
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

async function generateTypedDraft<Output>(input: {
  agent: Agent<string, ToolsInput, unknown>;
  schema: z.ZodType<Output>;
  prompt: string;
  fallbackJsonContract: string;
}): Promise<Output> {
  const result = await input.agent.generate([
    input.prompt,
    input.fallbackJsonContract,
  ].join('\n\n'), {
    toolChoice: 'none',
  });
  return input.schema.parse(result.object ?? parseJsonObject(result.text));
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
      format: FINAL_REPLY_FORMAT,
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
      format: FINAL_REPLY_FORMAT,
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

function turnFailureCategory(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof ZodError) return 'schema_validation';
  return 'runtime_failure';
}

function transactionKnownFromIntent(known: AccountingIntentDraft['known']) {
  return {
    ...(known.amount === undefined ? {} : { amount: known.amount }),
    ...(known.currency === undefined ? {} : { currency: known.currency }),
    ...(known.paymentAccountName === undefined ? {} : { paymentAccountName: known.paymentAccountName }),
    ...(known.occurredOn === undefined ? {} : { occurredOn: known.occurredOn }),
    ...(known.categoryName === undefined ? {} : { categoryName: known.categoryName }),
  };
}

function destinationFor(channel: ChannelKindV1, destination: unknown): Record<string, unknown> {
  if (destination !== null && typeof destination === 'object' && !Array.isArray(destination)) {
    return destination as Record<string, unknown>;
  }
  return channel === 'telegram' ? { chatId: '' } : { channelId: '' };
}

function normalizeFinalResponseDelivery(
  message: InboundChannelMessageV1,
  response: OrchestratorFinalResponseV1,
): OrchestratorFinalResponseV1 {
  return OrchestratorFinalResponseSchemaV1.parse({
    ...response,
    delivery: {
      channel: message.channel,
      destination: destinationFor(message.channel, message.metadata.destination),
      format: FINAL_REPLY_FORMAT,
    },
  });
}
