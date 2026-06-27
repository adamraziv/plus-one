import {
  CheckerVerdictSchemaV1,
  MakerArtifactSchemaV1,
  VerificationTaskSchemaV1,
} from '@plus-one/contracts';
import {
  AccountingClarificationSchemaV1,
  JournalWorkRequestSchemaV1,
} from '@plus-one/accounting';
import { toMastraModel } from '../../mastra/role-agent.js';
import {
  defaultAccountingRoleAgentFactory,
  type AccountingRoleAgent,
  type AccountingRoleAgentFactory,
  type AccountingRoleAgentInput,
} from './types.js';

export function createJournalCheckerAgent(input: AccountingRoleAgentInput): AccountingRoleAgent {
  const factory: AccountingRoleAgentFactory = input.agentFactory ?? defaultAccountingRoleAgentFactory;
  const fallback = factory({
    id: 'journal-checker',
    name: 'Journal Checker',
    description: 'Checks journal proposals for balance, account semantics, FX, and correction identity.',
    model: toMastraModel(input.models.checker),
    tools: {},
    instructions: [
      'Role: Journal Checker for Plus One.',
      'Input contract: the runtime puts the complete VerificationTaskV1 JSON in the user message context. Use that context as the only task input.',
      'Task: verify only the provided verification task and the exact maker artifact it contains.',
      'Reasoning protocol: think through privately in this order: confirm maker artifact id and hash, verify exact balance, verify posting directions and account semantics, verify transfer restrictions, verify FX provenance, verify reversal/replacement identity, decide accepted/rejected/revision_requested/insufficient_evidence/conflicted, then emit only CheckerVerdictV1.',
      'Decision rule: reject unbalanced proposals and wrong reverse/replace linkage.',
      'Constraint: Do not access databases, SQL, command handlers, command registries, provider accounts, external financial systems, arbitrary files, or unavailable tools.',
      'Output contract: Return only the structured CheckerVerdictV1 requested by the runtime.',
    ].join('\n'),
  });
  const fallbackGenerate = fallback.generate.bind(fallback) as
    (messages: unknown, options: unknown) => Promise<unknown>;
  fallback.generate = (async (messages: unknown, options: unknown) => {
    const task = parseVerificationTask(messages as readonly { role: string; content: string }[]);
    const verdict = task === undefined ? undefined : verdictForClarification(task);
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
  const request = JournalWorkRequestSchemaV1.safeParse(task.makerInput);
  if (!request.success || request.data.operation !== 'transfer') return undefined;
  return CheckerVerdictSchemaV1.parse({
    verdict: 'accepted',
    coveredArtifactId: task.makerArtifact.artifactId,
    coveredArtifactHash: task.makerArtifact.artifactHash,
    findings: [],
  });
}
