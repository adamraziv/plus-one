import {
  CheckerVerdictSchemaV1,
  MakerArtifactSchemaV1,
  VerificationTaskSchemaV1,
} from '@plus-one/contracts';
import {
  ChartClarificationSchemaV1,
  ChartOfAccountsProposalSchemaV1,
  ChartWorkRequestSchemaV1,
} from '@plus-one/accounting';
import { toMastraModel } from '../../mastra/role-agent.js';
import { submitContractResult } from '../../mastra/submit-contract-result.js';
import {
  defaultAccountingRoleAgentFactory,
  type AccountingRoleAgent,
  type AccountingRoleAgentFactory,
  type AccountingRoleAgentInput,
} from './types.js';

export function createChartCheckerAgent(input: AccountingRoleAgentInput): AccountingRoleAgent {
  const factory: AccountingRoleAgentFactory = input.agentFactory ?? defaultAccountingRoleAgentFactory;
  const fallback = factory({
    id: 'chart-checker',
    name: 'Chart Of Accounts Checker',
    description: 'Checks chart proposals or clarifications for scope, classification, hierarchy, currency, and confirmation boundary.',
    model: toMastraModel(input.models.checker),
    tools: {},
    instructions: [
      'Role: Chart Of Accounts Checker for Plus One.',
      'Input contract: the runtime puts the complete VerificationTaskV1 JSON in the user message context. Use that context as the only task input.',
      'Task: verify only the provided verification task and the exact maker artifact it contains.',
      'Reasoning protocol: think through privately in this order: confirm maker artifact id and hash, inspect whether the output is a proposal or clarification, verify household/book scope, verify account identity/class/normal balance/hierarchy/currency/archival fields/source mapping identity, verify every clarification field is genuinely absent from the maker input, verify the proposal still requires external confirmation before persistence, decide accepted/rejected/revision_requested/insufficient_evidence/conflicted, then emit only CheckerVerdictV1.',
      'Decision rule: do not treat a checker verdict as external confirmation.',
      'Decision rule: accept a valid chart-clarification only to terminate the work as insufficient evidence; it is never a mutation approval.',
      'Constraint: Do not access databases, SQL, command handlers, command registries, provider accounts, external financial systems, arbitrary files, or unavailable tools.',
      'Output contract: Return only the structured CheckerVerdictV1 requested by the runtime.',
    ].join('\n'),
  });
  const fallbackGenerate = fallback.generate.bind(fallback) as
    (messages: unknown, options: unknown) => Promise<unknown>;
  fallback.generate = (async (messages: unknown, options: unknown) => {
    const task = parseVerificationTask(messages as readonly { role: string; content: string }[]);
    const verdict = task === undefined
      ? undefined
      : verdictForClarification(task) ?? verdictForIdentityMismatch(task);
    if (verdict === undefined) return fallbackGenerate(messages, options);
    return submitContractResult(options, verdict);
  }) as typeof fallback.generate;
  return fallback;
}

function parseVerificationTask(messages: readonly { role: string; content: string }[]) {
  const content = [...messages].reverse().find((message) => message.role === 'user')?.content;
  if (content === undefined) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    return undefined;
  }
  const parsed = VerificationTaskSchemaV1.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

function verdictForClarification(task: NonNullable<ReturnType<typeof parseVerificationTask>>) {
  const maker = MakerArtifactSchemaV1.parse(task.makerArtifact.payload);
  const clarification = ChartClarificationSchemaV1.safeParse(maker.output);
  if (!clarification.success) return undefined;
  const request = ChartWorkRequestSchemaV1.safeParse(task.makerInput);
  if (!request.success) return undefined;
  const present = clarification.data.missingFields.filter((field) => !isMissing(field, request.data));
  return CheckerVerdictSchemaV1.parse({
    verdict: present.length === 0 ? 'accepted' : 'revision_requested',
    coveredArtifactId: task.makerArtifact.artifactId,
    coveredArtifactHash: task.makerArtifact.artifactHash,
    findings: present.map((field) => ({
      code: 'clarification_field_present',
      message: `Clarification asks for ${field}, but the request already provided it.`,
    })),
  });
}

function verdictForIdentityMismatch(task: NonNullable<ReturnType<typeof parseVerificationTask>>) {
  const maker = MakerArtifactSchemaV1.parse(task.makerArtifact.payload);
  const proposal = ChartOfAccountsProposalSchemaV1.safeParse(maker.output);
  const request = ChartWorkRequestSchemaV1.safeParse(task.makerInput);
  if (!proposal.success || !request.success || chartIdentityMatches(request.data, proposal.data)) {
    return undefined;
  }
  return CheckerVerdictSchemaV1.parse({
    verdict: 'revision_requested',
    coveredArtifactId: task.makerArtifact.artifactId,
    coveredArtifactHash: task.makerArtifact.artifactHash,
    findings: [{
      code: 'chart_identity_mismatch',
      message: 'The chart proposal changed a runtime-owned identity or scope field.',
    }],
  });
}

function chartIdentityMatches(
  request: ReturnType<typeof ChartWorkRequestSchemaV1.parse>,
  proposal: ReturnType<typeof ChartOfAccountsProposalSchemaV1.parse>,
): boolean {
  if (proposal.action !== request.action
    || proposal.householdId !== request.householdId
    || proposal.bookId !== request.bookId
    || proposal.accountId !== request.accountId) {
    return false;
  }
  if ('mappingId' in request) {
    if (!('mappingId' in proposal) || proposal.mappingId !== request.mappingId) return false;
  }
  if ('archivedMappingId' in request) {
    if (!('archivedMappingId' in proposal)
      || proposal.archivedMappingId !== request.archivedMappingId) return false;
  }
  return true;
}

function isMissing(
  field: ReturnType<typeof ChartClarificationSchemaV1.parse>['missingFields'][number],
  request: ReturnType<typeof ChartWorkRequestSchemaV1.parse>,
): boolean {
  if (field === 'name') return request.known.name === undefined;
  if (field === 'accounting_class') return request.known.accountingClass === undefined;
  if (field === 'normal_balance') return request.known.normalBalance === undefined;
  if (field === 'native_currency') return request.known.nativeCurrency === undefined;
  if (field === 'parent_account') return request.known.parentAccountId === undefined;
  if (field === 'source_system') return request.known.sourceSystem === undefined;
  if (field === 'external_account_id') return request.known.externalAccountId === undefined;
  return false;
}
