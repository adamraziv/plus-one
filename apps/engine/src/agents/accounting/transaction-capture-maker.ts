import { MakerArtifactSchemaV1, MakerInvocationSchemaV1 } from '@plus-one/contracts';
import {
  AccountingClarificationSchemaV1,
  AccountingJournalMutationProposalSchemaV1,
  TransactionCaptureRequestSchemaV1,
} from '@plus-one/accounting';
import { toMastraModel } from '../../mastra/role-agent.js';
import { submitContractResult } from '../../mastra/submit-contract-result.js';
import {
  defaultAccountingRoleAgentFactory,
  type AccountingRoleAgent,
  type AccountingRoleAgentFactory,
  type AccountingRoleAgentInput,
} from './types.js';

export function createTransactionCaptureMakerAgent(input: AccountingRoleAgentInput): AccountingRoleAgent {
  const factory: AccountingRoleAgentFactory = input.agentFactory ?? defaultAccountingRoleAgentFactory;
  const fallback = factory({
    id: 'transaction-capture-maker',
    name: 'Transaction Capture Maker',
    description: 'Converts explicit user instructions into balanced accounting proposals or clarifications.',
    model: toMastraModel(input.models.maker),
    tools: {},
    instructions: [
      'Role: Transaction Capture Maker for Plus One.',
      'Input contract: the runtime puts the complete MakerInvocationV1 JSON with TransactionCaptureRequestV1 input in the user message context. Use that context as the only task input.',
      'Task: convert an explicit user instruction into a balanced accounting journal mutation proposal or accounting-clarification.',
      'Reasoning protocol: think through privately in this order: read the MakerInvocationV1 input, confirm explicitInstruction is true, identify amount/currency/payment account/date/category/exchange-rate evidence, produce a balanced proposal only when material fields are reliable, otherwise produce accounting-clarification, then emit only MakerArtifactV1.',
      'Constraint: never infer a material payment account, currency, amount, occurred-on date, category, or exchange rate without reliable evidence.',
      'Constraint: if payment account, occurred-on date, or category is missing or ambiguous, return accounting-clarification instead of a proposal.',
      'Constraint: do not claim persistence, external confirmation, or command execution.',
      'Constraint: Do not access databases, SQL, command handlers, command registries, provider accounts, external financial systems, arbitrary files, or unavailable tools.',
      'Output contract: MakerArtifactV1.output must be either accounting-journal-mutation-proposal v1 or accounting-clarification v1, and it must include schemaName and schemaVersion inside output.',
      'Output contract: never return shorthand objects like { journal: ... } or omit the inner discriminator fields.',
      'Output contract: Return only the structured MakerArtifactV1 requested by the runtime.',
    ].join('\n'),
  });
  const fallbackGenerate = fallback.generate.bind(fallback) as
    (messages: unknown, options: unknown) => Promise<unknown>;
  fallback.generate = (async (messages: unknown, options: unknown) => {
    const invocation = parseMakerInvocation(messages as readonly { role: string; content: string }[]);
    const artifact = invocation === undefined
      ? undefined
      : clarificationArtifact(invocation) ?? deterministicProposalArtifact(invocation);
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
  const request = TransactionCaptureRequestSchemaV1.safeParse(invocation.input);
  if (!request.success) return undefined;
  const missing = missingFields(request.data);
  if (missing.length === 0) return undefined;
  const output = AccountingClarificationSchemaV1.parse({
    schemaName: 'accounting-clarification',
    schemaVersion: 1,
    missingFields: missing,
    questions: missing.map(questionFor),
    reason: 'The transaction cannot be posted until required accounting fields are provided.',
  });
  return MakerArtifactSchemaV1.parse({
    schemaName: 'maker-artifact',
    schemaVersion: 1,
    outputSchema: invocation.outputSchema,
    output,
    claims: [{
      claimId: 'transaction-capture-clarification',
      text: 'The transaction capture request is missing required accounting fields.',
      evidenceArtifactIds: [],
    }],
    assumptions: [],
    uncertainty: missing.map((field) => `Missing ${field}.`),
  });
}

function deterministicProposalArtifact(invocation: NonNullable<ReturnType<typeof parseMakerInvocation>>) {
  const request = TransactionCaptureRequestSchemaV1.safeParse(invocation.input);
  if (!request.success || !isDeterministicProposalReady(request.data)) return undefined;
  const suffix = idSuffix(invocation.taskId);
  const amount = request.data.known.amount!;
  const currency = request.data.known.currency!;
  const occurredOn = request.data.known.occurredOn!;
  const output = AccountingJournalMutationProposalSchemaV1.parse({
    schemaName: 'accounting-journal-mutation-proposal',
    schemaVersion: 1,
    operation: 'post',
    draft: {
      draftSeriesId: `draftseries_${suffix}`,
      version: 1,
      journal: {
        schemaName: 'post-journal-proposal',
        schemaVersion: 1,
        householdId: request.data.householdId,
        bookId: request.data.bookId,
        journalId: `journal_${suffix}`,
        draftId: `draft_${suffix}`,
        periodId: request.data.periodId,
        taskId: invocation.taskId,
        journalType: 'ordinary',
        transactionCurrency: currency,
        occurredOn,
        effectiveOn: occurredOn,
        description: request.data.instruction,
        tagIds: [],
        postings: [
          {
            accountId: request.data.known.categoryAccountId,
            direction: 'debit',
            transactionAmount: amount,
            accountNativeAmount: amount,
            accountNativeCurrency: request.data.categoryAccountCurrency,
            tagIds: [],
          },
          {
            accountId: request.data.known.paymentAccountId,
            direction: 'credit',
            transactionAmount: amount,
            accountNativeAmount: amount,
            accountNativeCurrency: request.data.paymentAccountCurrency,
            tagIds: [],
          },
        ],
      },
    },
  });
  return MakerArtifactSchemaV1.parse({
    schemaName: 'maker-artifact',
    schemaVersion: 1,
    outputSchema: invocation.outputSchema,
    output,
    claims: [{
      claimId: 'transaction-capture-proposal',
      text: 'Prepared a balanced transaction capture journal proposal.',
      evidenceArtifactIds: [],
    }],
    assumptions: [],
    uncertainty: [],
  });
}

function missingFields(request: ReturnType<typeof TransactionCaptureRequestSchemaV1.parse>) {
  return [
    ...(request.known.amount === undefined ? ['amount' as const] : []),
    ...(request.known.currency === undefined ? ['currency' as const] : []),
    ...(request.known.paymentAccountId === undefined ? ['payment_account' as const] : []),
    ...(request.known.occurredOn === undefined ? ['occurred_on' as const] : []),
    ...(request.known.categoryAccountId === undefined ? ['category' as const] : []),
  ];
}

function isDeterministicProposalReady(request: ReturnType<typeof TransactionCaptureRequestSchemaV1.parse>) {
  return missingFields(request).length === 0
    && request.periodId !== undefined
    && request.paymentAccountCurrency !== undefined
    && request.categoryAccountCurrency !== undefined
    && request.paymentAccountCurrency === request.known.currency
    && request.categoryAccountCurrency === request.known.currency;
}

function idSuffix(taskId: string): string {
  const separator = taskId.indexOf('_');
  return separator === -1 ? taskId : taskId.slice(separator + 1);
}

function questionFor(field: ReturnType<typeof missingFields>[number]): string {
  if (field === 'amount') return 'What amount should be recorded?';
  if (field === 'currency') return 'What currency should be used?';
  if (field === 'payment_account') return 'Which account did you pay from?';
  if (field === 'occurred_on') return 'On what date did the transaction occur?';
  return 'What category should I use for this transaction?';
}
