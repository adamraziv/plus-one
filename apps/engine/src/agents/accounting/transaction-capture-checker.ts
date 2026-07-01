import {
  CheckerVerdictSchemaV1,
  MakerArtifactSchemaV1,
  VerificationTaskSchemaV1,
} from '@plus-one/contracts';
import {
  AccountingClarificationSchemaV1,
  AccountingJournalMutationProposalSchemaV1,
  TransactionCaptureRequestSchemaV1,
  type AccountingJournalMutationProposalV1,
} from '@plus-one/accounting';
import { toMastraModel } from '../../mastra/role-agent.js';
import {
  defaultAccountingRoleAgentFactory,
  type AccountingRoleAgent,
  type AccountingRoleAgentFactory,
  type AccountingRoleAgentInput,
} from './types.js';

type PostAccountingJournalMutationProposalV1 = Extract<AccountingJournalMutationProposalV1, { operation: 'post' }>;

export function createTransactionCaptureCheckerAgent(input: AccountingRoleAgentInput): AccountingRoleAgent {
  const factory: AccountingRoleAgentFactory = input.agentFactory ?? defaultAccountingRoleAgentFactory;
  const fallback = factory({
    id: 'transaction-capture-checker',
    name: 'Transaction Capture Checker',
    description: 'Checks transaction capture proposals or clarifications against exact artifact evidence.',
    model: toMastraModel(input.models.checker),
    tools: {},
    instructions: [
      'Role: Transaction Capture Checker for Plus One.',
      'Input contract: the runtime puts the complete VerificationTaskV1 JSON in the user message context. Use that context as the only task input.',
      'Task: verify only the provided verification task and the exact maker artifact it contains.',
      'Reasoning protocol: think through privately in this order: confirm maker artifact id and hash, inspect output schema, verify debit/credit equality, verify required fields/account scope/currency/dates/correction semantics/evidence references, decide accepted/rejected/revision_requested/insufficient_evidence/conflicted, then emit only CheckerVerdictV1.',
      'Decision rule: accept accounting-clarification only when a material field is genuinely unresolved.',
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
      : verdictForClarification(task) ?? verdictForDeterministicProposal(task);
    if (verdict === undefined) return fallbackGenerate(messages, options);
    return { object: verdict };
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
  const clarification = AccountingClarificationSchemaV1.safeParse(maker.output);
  if (!clarification.success) return undefined;
  const request = TransactionCaptureRequestSchemaV1.safeParse(task.makerInput);
  if (!request.success) return undefined;
  const missing = clarification.data.missingFields.filter((field) => !isMissing(field, request.data));
  return CheckerVerdictSchemaV1.parse({
    verdict: missing.length === 0 ? 'accepted' : 'revision_requested',
    coveredArtifactId: task.makerArtifact.artifactId,
    coveredArtifactHash: task.makerArtifact.artifactHash,
    findings: missing.map((field) => ({
      code: 'clarification_field_present',
      message: `Clarification asks for ${field}, but the request already provided it.`,
    })),
  });
}

function verdictForDeterministicProposal(task: NonNullable<ReturnType<typeof parseVerificationTask>>) {
  const maker = MakerArtifactSchemaV1.parse(task.makerArtifact.payload);
  const request = TransactionCaptureRequestSchemaV1.safeParse(task.makerInput);
  if (!request.success) return undefined;
  if (!isDeterministicProposalReady(request.data)) return undefined;
  const proposal = parseDeterministicProposal(maker.output);
  if (proposal === undefined || !matchesDeterministicProposal(task.taskId, request.data, proposal)) {
    return undefined;
  }
  return CheckerVerdictSchemaV1.parse({
    verdict: 'accepted',
    coveredArtifactId: task.makerArtifact.artifactId,
    coveredArtifactHash: task.makerArtifact.artifactHash,
    findings: [],
  });
}

function isMissing(
  field: ReturnType<typeof AccountingClarificationSchemaV1.parse>['missingFields'][number],
  request: ReturnType<typeof TransactionCaptureRequestSchemaV1.parse>,
): boolean {
  if (field === 'amount') return request.known.amount === undefined;
  if (field === 'currency') return request.known.currency === undefined;
  if (field === 'payment_account') return request.known.paymentAccountId === undefined;
  if (field === 'occurred_on') return request.known.occurredOn === undefined;
  if (field === 'category') return request.known.categoryAccountId === undefined;
  return true;
}

function isDeterministicProposalReady(request: ReturnType<typeof TransactionCaptureRequestSchemaV1.parse>) {
  return request.known.amount !== undefined
    && request.known.currency !== undefined
    && request.known.paymentAccountId !== undefined
    && request.known.occurredOn !== undefined
    && request.known.categoryAccountId !== undefined
    && request.periodId !== undefined
    && request.paymentAccountCurrency !== undefined
    && request.categoryAccountCurrency !== undefined
    && request.paymentAccountCurrency === request.known.currency
    && request.categoryAccountCurrency === request.known.currency;
}

function matchesDeterministicProposal(
  taskId: string,
  request: ReturnType<typeof TransactionCaptureRequestSchemaV1.parse>,
  proposal: PostAccountingJournalMutationProposalV1,
): boolean {
  const suffix = idSuffix(taskId);
  const journal = proposal.draft.journal;
  if (proposal.draft.draftSeriesId !== `draftseries_${suffix}`
    || proposal.draft.version !== 1
    || journal.householdId !== request.householdId
    || journal.bookId !== request.bookId
    || journal.journalId !== `journal_${suffix}`
    || journal.draftId !== `draft_${suffix}`
    || journal.periodId !== request.periodId
    || journal.taskId !== taskId
    || journal.journalType !== 'ordinary'
    || journal.transactionCurrency !== request.known.currency
    || journal.occurredOn !== request.known.occurredOn
    || journal.effectiveOn !== request.known.occurredOn
    || journal.description !== request.instruction
    || journal.tagIds.length !== 0
    || journal.postings.length !== 2) {
    return false;
  }
  const debit = journal.postings.find((posting) => posting.direction === 'debit');
  const credit = journal.postings.find((posting) => posting.direction === 'credit');
  return debit !== undefined
    && credit !== undefined
    && debit.accountId === request.known.categoryAccountId
    && debit.transactionAmount === request.known.amount
    && debit.accountNativeAmount === request.known.amount
    && debit.accountNativeCurrency === request.categoryAccountCurrency
    && debit.tagIds.length === 0
    && credit.accountId === request.known.paymentAccountId
    && credit.transactionAmount === request.known.amount
    && credit.accountNativeAmount === request.known.amount
    && credit.accountNativeCurrency === request.paymentAccountCurrency
    && credit.tagIds.length === 0;
}

function idSuffix(taskId: string): string {
  const separator = taskId.indexOf('_');
  return separator === -1 ? taskId : taskId.slice(separator + 1);
}

function parseDeterministicProposal(output: unknown): PostAccountingJournalMutationProposalV1 | undefined {
  const parsed = AccountingJournalMutationProposalSchemaV1.safeParse(output);
  if (!parsed.success || parsed.data.operation !== 'post') return undefined;
  return parsed.data;
}
