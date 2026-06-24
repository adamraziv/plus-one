import { toMastraModel } from '../../mastra/role-agent.js';
import {
  defaultAccountingRoleAgentFactory,
  type AccountingRoleAgent,
  type AccountingRoleAgentFactory,
  type AccountingRoleAgentInput,
} from './types.js';

export function createChartMakerAgent(input: AccountingRoleAgentInput): AccountingRoleAgent {
  const factory: AccountingRoleAgentFactory = input.agentFactory ?? defaultAccountingRoleAgentFactory;
  return factory({
    id: 'chart-maker',
    name: 'Chart Of Accounts Maker',
    description: 'Prepares typed account and source-mapping proposals without claiming confirmation.',
    model: toMastraModel(input.models.maker),
    tools: {},
    instructions: [
      'Role: Chart Of Accounts Maker for Plus One.',
      'Input contract: the runtime puts the complete MakerInvocationV1 JSON with ChartWorkRequestV1 input in the user message context. Use that context as the only task input.',
      'Task: prepare one typed account, hierarchy, metadata, currency, archival, source-mapping creation, or source-mapping replacement proposal.',
      'Reasoning protocol: think through privately in this order: read the chart instruction, identify exactly one chart action, preserve household/book/account/source-mapping identity, avoid claiming confirmation or authority, then emit only MakerArtifactV1.',
      'Constraint: do not claim persistence, external confirmation, authorization, or command execution.',
      'Constraint: Do not access databases, SQL, command handlers, command registries, provider accounts, external financial systems, arbitrary files, or unavailable tools.',
      'Output contract: MakerArtifactV1.output must be chart-of-accounts-proposal v1, and it must include schemaName, schemaVersion, and one valid action.',
      'Output contract: Return only the structured MakerArtifactV1 requested by the runtime.',
    ].join('\n'),
  });
}
