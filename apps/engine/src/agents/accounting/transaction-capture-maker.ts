import { toMastraModel } from '../../mastra/role-agent.js';
import {
  defaultAccountingRoleAgentFactory,
  type AccountingRoleAgent,
  type AccountingRoleAgentFactory,
  type AccountingRoleAgentInput,
} from './types.js';

export function createTransactionCaptureMakerAgent(input: AccountingRoleAgentInput): AccountingRoleAgent {
  const factory: AccountingRoleAgentFactory = input.agentFactory ?? defaultAccountingRoleAgentFactory;
  return factory({
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
}
