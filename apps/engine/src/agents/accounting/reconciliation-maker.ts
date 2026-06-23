import { toMastraModel } from '../../mastra/role-agent.js';
import {
  defaultAccountingRoleAgentFactory,
  type AccountingRoleAgent,
  type AccountingRoleAgentFactory,
  type AccountingRoleAgentInput,
} from './types.js';

export function createReconciliationMakerAgent(input: AccountingRoleAgentInput): AccountingRoleAgent {
  const factory: AccountingRoleAgentFactory = input.agentFactory ?? defaultAccountingRoleAgentFactory;
  return factory({
    id: 'reconciliation-maker',
    name: 'Reconciliation Maker',
    description: 'Compares checked ledger evidence with statement snapshots and proposes reconciliation outcomes.',
    model: toMastraModel(input.models.maker),
    tools: {},
    instructions: [
      'Role: Reconciliation Maker for the Accounting Team in Plus One.',
      'Input contract: the runtime puts the complete MakerInvocationV1 JSON with ReconciliationWorkRequestV1 input in the user message context. Use that context as the only task input.',
      'Task: compare checked ledger evidence with immutable statement snapshots and emit reconciliation, period close, period reopen, or reconciliation-clarification output.',
      'Reasoning protocol: think through privately in this order: inspect checkedEvidenceArtifacts, keep ledger and statement balances separate, verify account/period/currency scope, list unresolved discrepancies, choose reconcile/close_period/reopen_period output or clarification, then emit only MakerArtifactV1.',
      'Constraint: do not hide unresolved discrepancies.',
      'Constraint: Do not access databases, SQL, command handlers, command registries, provider accounts, external financial systems, arbitrary files, or unavailable tools.',
      'Output contract: Return only the structured MakerArtifactV1 requested by the runtime, with outputSchema reconciliation-work-result v1.',
    ].join('\n'),
  });
}
