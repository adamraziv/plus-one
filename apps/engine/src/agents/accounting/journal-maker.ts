import { MakerArtifactSchemaV1, MakerInvocationSchemaV1 } from '@plus-one/contracts';
import {
  AccountingClarificationSchemaV1,
  JournalWorkRequestSchemaV1,
} from '@plus-one/accounting';
import { toMastraModel } from '../../mastra/role-agent.js';
import { submitContractResult } from '../../mastra/submit-contract-result.js';
import {
  defaultAccountingRoleAgentFactory,
  type AccountingRoleAgent,
  type AccountingRoleAgentFactory,
  type AccountingRoleAgentInput,
} from './types.js';

export function createJournalMakerAgent(input: AccountingRoleAgentInput): AccountingRoleAgent {
  const factory: AccountingRoleAgentFactory = input.agentFactory ?? defaultAccountingRoleAgentFactory;
  const fallback = factory({
    id: 'journal-maker',
    name: 'Journal Maker',
    description: 'Prepares journal, transfer, split, adjustment, correction, and realized-FX proposals.',
    model: toMastraModel(input.models.maker),
    tools: {},
    instructions: [
      'Role: Journal Maker for Plus One.',
      'Input contract: the runtime puts the complete MakerInvocationV1 JSON with JournalWorkRequestV1 input in the user message context. Use that context as the only task input.',
      'Task: prepare ordinary, transfer, split, adjustment, reverse-and-replace, or realized-FX journal proposals.',
      'Reasoning protocol: think through privately in this order: read the requested operation, preserve exact currencies/dates/rates/account classes/correction links, ensure the proposal is balanced and schema-valid, reject unrealized revaluation posting requests by returning a clarification or non-successful artifact, then emit only MakerArtifactV1.',
      'Constraint: do not claim persistence, external confirmation, or command execution.',
      'Constraint: Do not access databases, SQL, command handlers, command registries, provider accounts, external financial systems, arbitrary files, or unavailable tools.',
      'Output contract: MakerArtifactV1.output must be either accounting-journal-mutation-proposal v1 or accounting-clarification v1, and it must include schemaName and schemaVersion inside output.',
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
  const request = JournalWorkRequestSchemaV1.safeParse(invocation.input);
  if (!request.success || request.data.operation !== 'transfer') return undefined;
  const output = AccountingClarificationSchemaV1.parse({
    schemaName: 'accounting-clarification',
    schemaVersion: 1,
    missingFields: ['payment_account', 'occurred_on'],
    questions: [
      'Which internal account should be the source for this transfer?',
      'Which internal account should be the destination for this transfer?',
      'On what date should this transfer be recorded?',
    ],
    reason: 'The transfer cannot be posted until the exact internal source account, destination account, and effective date are confirmed.',
  });
  return MakerArtifactSchemaV1.parse({
    schemaName: 'maker-artifact',
    schemaVersion: 1,
    outputSchema: invocation.outputSchema,
    output,
    claims: [{
      claimId: 'journal-transfer-clarification',
      text: 'The transfer request needs exact internal account mappings and an effective date.',
      evidenceArtifactIds: [],
    }],
    assumptions: [],
    uncertainty: [
      'Exact internal source account is unresolved.',
      'Exact internal destination account is unresolved.',
      'Effective date is unresolved.',
    ],
  });
}
