import {
  EvidenceRequestSchemaV1,
  MakerArtifactSchemaV1,
  MakerInvocationSchemaV1,
  QueryResultSchemaV1,
} from '@plus-one/contracts';
import { splitQueryRoleTools } from './tools.js';
import { toMastraModel } from '../../mastra/role-agent.js';
import { submitContractResult } from '../../mastra/submit-contract-result.js';
import {
  defaultQueryRoleAgentFactory,
  type QueryRoleAgent,
  type QueryRoleAgentFactory,
  type QueryRoleAgentInput,
} from './types.js';

export function createQueryMakerAgent(input: QueryRoleAgentInput): QueryRoleAgent {
  const config = {
    id: 'query-maker',
    name: 'Query Maker',
    description: 'Uses governed read-only Query tools to produce structured household evidence.',
    model: toMastraModel(input.models.maker),
    tools: splitQueryRoleTools(input.tools, 'query-maker'),
    instructions: [
      'Role: Query Maker for Plus One.',
      'Input contract: the runtime puts the complete MakerInvocationV1 JSON in the user message context. Use that context as the only task input.',
      'Task: produce checked read-only household evidence by calling only active governed Query tools attached to this agent.',
      'Reasoning protocol: think through privately in this order: read the MakerInvocationV1 input, identify the requested relation/grain/freshness/filters, choose the matching active Query tool, call it with invocation parameters only, inspect returned coverage warnings, then emit only MakerArtifactV1.',
      'Tool selection map: coverage "account list" -> query_account_list; "balance snapshot" -> query_current_balances; "categorized transactions" -> query_categorized_transactions; "category spend monthly" -> query_category_spend_monthly; "budget variance" -> query_budget_variance; "savings goal progress" -> query_savings_goal_progress; "debt progress" -> query_debt_progress; "reconciliation status" -> query_reconciliation_status; "source freshness" -> query_source_freshness.',
      'Tool input rule: for household-scoped Query tools, pass householdId from MakerInvocationV1.householdId.',
      'Claim evidence rule: MakerArtifactV1.claims[].evidenceArtifactIds must be empty when permittedEvidence is empty; do not invent artifact IDs for tool outputs.',
      'Claim rule: include at least one claim summarizing what the checked QueryResultV1 shows.',
      'Citation rule: preserve tool provenance in QueryResultV1.sourceReferences and rely on the checked maker artifact for final citations.',
      'Constraint: never write SQL directly in the response; Query SQL is owned by the registered tool definitions.',
      'Constraint: never mutate household data, imply a write action, or use unavailable tools.',
      'Evidence rule: preserve relation, household scope, grain, freshness, field definitions, source references, and coverage warnings in the output.',
      'Output contract: return only the structured MakerArtifactV1 requested by the runtime.',
    ].join('\n'),
  } satisfies Parameters<QueryRoleAgentFactory>[0];
  if (input.agentFactory !== undefined) return input.agentFactory(config);

  const fallback = defaultQueryRoleAgentFactory(config);
  const tools = config.tools as Record<string, { execute: (input: unknown, options: unknown) => Promise<unknown> }>;
  const fallbackGenerate = fallback.generate.bind(fallback) as
    (messages: unknown, options: unknown) => Promise<unknown>;
  fallback.generate = (async (messages: unknown, options: unknown) => {
    const invocation = parseMakerInvocation(messages as readonly { role: string; content: string }[]);
    const toolId = queryToolIdFor(invocation);
    const activeTools = Array.isArray((options as { activeTools?: unknown }).activeTools)
      ? (options as { activeTools: unknown[] }).activeTools.filter((value): value is string => typeof value === 'string')
      : [];
    const tool = toolId === undefined || !activeTools.includes(toolId) ? undefined : tools[toolId];
    if (tool === undefined || invocation.outputSchema.schemaName !== 'query-result') {
      return fallbackGenerate(messages, options);
    }
    const queryResult = QueryResultSchemaV1.parse(await tool.execute({
      householdId: invocation.householdId,
    }, {}));
    const rowLabel = queryResult.rows.length === 1 ? 'row' : 'rows';
    const artifact = MakerArtifactSchemaV1.parse({
        schemaName: 'maker-artifact',
        schemaVersion: 1,
        outputSchema: invocation.outputSchema,
        output: queryResult,
        claims: [{
          claimId: 'query-result-summary',
          text: `Query result from ${queryResult.relationName} returned ${queryResult.rows.length} ${rowLabel}.`,
          evidenceArtifactIds: [],
        }],
        assumptions: [],
        uncertainty: [],
      });
    return submitContractResult(
      options,
      artifact,
      [{ payload: { toolName: toolId, result: queryResult } }],
    );
  }) as typeof fallback.generate;
  return fallback;
}

function parseMakerInvocation(messages: readonly { role: string; content: string }[]) {
  const content = [...messages].reverse().find((message) => message.role === 'user')?.content;
  return MakerInvocationSchemaV1.parse(JSON.parse(content ?? 'null'));
}

function queryToolIdFor(invocation: ReturnType<typeof parseMakerInvocation>): string | undefined {
  const input = EvidenceRequestSchemaV1.safeParse(invocation.input);
  if (!input.success) return undefined;
  const coverage = input.data.coverage[0];
  if (coverage === 'account list' || coverage === 'reporting.accounts') return 'query_account_list';
  if (coverage === 'balance snapshot' || coverage === 'reporting.current_balances'
    || coverage === 'reporting.account_current_balances') {
    return 'query_current_balances';
  }
  if (coverage === 'categorized transactions' || coverage === 'reporting.categorized_transactions') {
    return 'query_categorized_transactions';
  }
  if (coverage === 'category spend monthly' || coverage === 'reporting.category_spend_monthly') {
    return 'query_category_spend_monthly';
  }
  if (coverage === 'budget variance' || coverage === 'reporting.budget_variance') return 'query_budget_variance';
  if (coverage === 'savings goal progress' || coverage === 'reporting.savings_goal_progress') {
    return 'query_savings_goal_progress';
  }
  if (coverage === 'debt progress' || coverage === 'reporting.debt_progress') return 'query_debt_progress';
  if (coverage === 'reconciliation status' || coverage === 'reporting.reconciliation_status') {
    return 'query_reconciliation_status';
  }
  if (coverage === 'source freshness' || coverage === 'reporting.source_freshness') {
    return 'query_source_freshness';
  }
  return undefined;
}
