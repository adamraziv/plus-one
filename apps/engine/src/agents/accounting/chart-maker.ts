import { MakerArtifactSchemaV1, MakerInvocationSchemaV1 } from '@plus-one/contracts';
import { ChartClarificationSchemaV1, ChartWorkRequestSchemaV1 } from '@plus-one/accounting';
import { toMastraModel } from '../../mastra/role-agent.js';
import { submitContractResult } from '../../mastra/submit-contract-result.js';
import {
  defaultAccountingRoleAgentFactory,
  type AccountingRoleAgent,
  type AccountingRoleAgentFactory,
  type AccountingRoleAgentInput,
} from './types.js';

export function createChartMakerAgent(input: AccountingRoleAgentInput): AccountingRoleAgent {
  const factory: AccountingRoleAgentFactory = input.agentFactory ?? defaultAccountingRoleAgentFactory;
  const fallback = factory({
    id: 'chart-maker',
    name: 'Chart Of Accounts Maker',
    description: 'Prepares typed account and source-mapping proposals or safe clarifications without claiming confirmation.',
    model: toMastraModel(input.models.maker),
    tools: {},
    instructions: [
      'Role: Chart Of Accounts Maker for Plus One.',
      'Input contract: the runtime puts the complete MakerInvocationV1 JSON with ChartWorkRequestV1 input in the user message context. Use that context as the only task input.',
      'Task: prepare one typed account, hierarchy, metadata, currency, archival, source-mapping creation, or source-mapping replacement proposal, or return chart-clarification when user-owned fields are unresolved.',
      'Reasoning protocol: think through privately in this order: read the chart instruction, identify exactly one chart action, preserve household/book/account/source-mapping identity exactly, identify unresolved user-owned fields, avoid claiming confirmation or authority, then emit only MakerArtifactV1.',
      'Constraint: never create identifiers, infer accounting class, currency, or normal balance, or choose a parent account silently.',
      'Constraint: do not claim persistence, external confirmation, authorization, or command execution.',
      'Constraint: Do not access databases, SQL, command handlers, command registries, provider accounts, external financial systems, arbitrary files, or unavailable tools.',
      'Output contract: MakerArtifactV1.output must be either chart-of-accounts-proposal v1 or chart-clarification v1, and it must include schemaName and schemaVersion.',
      'Output contract: Return only the structured MakerArtifactV1 requested by the runtime.',
    ].join('\n'),
  });
  const fallbackGenerate = fallback.generate.bind(fallback) as
    (messages: unknown, options: unknown) => Promise<unknown>;
  fallback.generate = (async (messages: unknown, options: unknown) => {
    const invocation = parseMakerInvocation(messages as readonly { role: string; content: string }[]);
    const artifact = invocation === undefined ? undefined : clarificationArtifact(invocation);
    if (artifact === undefined) return fallbackGenerate(messages, options);
    return submitContractResult(options, artifact);
  }) as typeof fallback.generate;
  return fallback;
}

function parseMakerInvocation(messages: readonly { role: string; content: string }[]) {
  const content = [...messages].reverse().find((message) => message.role === 'user')?.content;
  if (content === undefined) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    return undefined;
  }
  const parsed = MakerInvocationSchemaV1.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

function clarificationArtifact(invocation: NonNullable<ReturnType<typeof parseMakerInvocation>>) {
  const request = ChartWorkRequestSchemaV1.safeParse(invocation.input);
  if (!request.success) return undefined;
  const missing = missingFields(request.data);
  if (missing.length === 0) return undefined;
  const output = ChartClarificationSchemaV1.parse({
    schemaName: 'chart-clarification',
    schemaVersion: 1,
    missingFields: missing,
    questions: missing.map(questionFor),
    reason: 'A safe chart-of-accounts proposal requires the unresolved user-owned fields.',
  });
  return MakerArtifactSchemaV1.parse({
    schemaName: 'maker-artifact',
    schemaVersion: 1,
    outputSchema: invocation.outputSchema,
    output,
    claims: [{
      claimId: 'chart-clarification',
      text: 'The chart request is missing required user-owned fields.',
      evidenceArtifactIds: [],
    }],
    assumptions: [],
    uncertainty: missing.map((field) => `Missing ${field}.`),
  });
}

function missingFields(request: ReturnType<typeof ChartWorkRequestSchemaV1.parse>) {
  if (request.action === 'create_account' || request.action === 'update_account') {
    return [
      ...(request.known.name === undefined ? ['name' as const] : []),
      ...(request.known.accountingClass === undefined ? ['accounting_class' as const] : []),
      ...(request.known.accountingClass !== undefined && request.known.normalBalance === undefined
        ? ['normal_balance' as const]
        : []),
      ...(request.known.nativeCurrency === undefined ? ['native_currency' as const] : []),
    ];
  }
  if (request.action === 'create_source_mapping' || request.action === 'replace_source_mapping') {
    return [
      ...(request.known.sourceSystem === undefined ? ['source_system' as const] : []),
      ...(request.known.externalAccountId === undefined ? ['external_account_id' as const] : []),
    ];
  }
  return [];
}

function questionFor(field: ReturnType<typeof missingFields>[number]): string {
  if (field === 'name') return 'What should the account be called?';
  if (field === 'accounting_class') {
    return 'Is this an asset, liability, equity, income, or expense account?';
  }
  if (field === 'normal_balance') return 'Should this account normally carry a debit or credit balance?';
  if (field === 'native_currency') return 'What is its native currency?';
  if (field === 'source_system') return 'Which source system should this account mapping use?';
  return 'What is the external account identifier for this source mapping?';
}
