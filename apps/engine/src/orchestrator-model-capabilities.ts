import { randomUUID } from 'node:crypto';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { PlusOneError } from '@plus-one/contracts';
import { z } from 'zod';
import type { EngineLlmModelConfig } from './config.js';
import { toMastraModel } from './mastra/role-agent.js';

const ProbeNonce = 'plus-one-orchestrator-capability-probe';
const DirectEvidence = 'direct';

const ProbeResultSchema = z.object({
  status: z.literal('ok'),
  evidence: z.string().min(1),
}).strict();

type Capability = 'native_structured_output' | 'tool_then_structured_output';

interface CapabilityValidatorDependencies {
  createAgent?: (options: ConstructorParameters<typeof Agent>[0]) => Agent;
  createMastra?: (options: ConstructorParameters<typeof Mastra>[0]) => Mastra;
  createReceipt?: () => string;
}

export async function validateOrchestratorModelCapabilities(
  input: { model: EngineLlmModelConfig },
  dependencies: CapabilityValidatorDependencies = {},
): Promise<void> {
  const receipt = (dependencies.createReceipt ?? randomUUID)();
  let toolExecutionCount = 0;
  const capabilityProbe = createTool({
    id: 'capabilityProbe',
    description: 'Run only when the capability-check prompt explicitly requires this tool.',
    inputSchema: z.object({ nonce: z.literal(ProbeNonce) }).strict(),
    outputSchema: z.object({ receipt: z.string().min(1) }).strict(),
    execute: async () => {
      toolExecutionCount += 1;
      return { receipt };
    },
  });
  const createAgent = dependencies.createAgent ?? ((options) => new Agent(options));
  const agent = createAgent({
    id: 'orchestrator-model-capability-probe',
    name: 'Orchestrator model capability probe',
    model: toMastraModel(input.model),
    tools: { capabilityProbe },
    instructions: [
      'You validate whether the configured model can satisfy the Plus One orchestrator contract.',
      'Follow each capability-check prompt exactly.',
      'Return only the requested structured output.',
    ].join('\n'),
  });
  const mastra = (dependencies.createMastra ?? ((options) => new Mastra(options)))({
    agents: { orchestratorModelCapabilityProbe: agent },
    logger: false,
  });

  try {
    await runProbe(input.model.id, 'native_structured_output', async () => {
      const executionsBeforeProbe = toolExecutionCount;
      const result = await agent.generate([
        'Capability check: answer directly without calling any tool.',
        `Return status "ok" and evidence "${DirectEvidence}".`,
      ].join(' '), {
        maxSteps: 1,
        toolChoice: 'auto',
        structuredOutput: { schema: ProbeResultSchema },
      });
      const parsed = ProbeResultSchema.parse(result.object);
      if (parsed.evidence !== DirectEvidence || toolExecutionCount !== executionsBeforeProbe) {
        throw new Error('Direct native structured-output probe did not follow its contract.');
      }
    });

    await runProbe(input.model.id, 'tool_then_structured_output', async () => {
      const executionsBeforeProbe = toolExecutionCount;
      const result = await agent.generate([
        `Capability check: call capabilityProbe exactly once with nonce "${ProbeNonce}".`,
        'After the tool returns, set status to "ok" and copy its receipt into evidence.',
      ].join(' '), {
        maxSteps: 2,
        toolChoice: 'auto',
        structuredOutput: { schema: ProbeResultSchema },
      });
      const parsed = ProbeResultSchema.parse(result.object);
      if (
        toolExecutionCount !== executionsBeforeProbe + 1
        || parsed.evidence !== receipt
      ) {
        throw new Error('Tool-to-structured-output probe did not follow its contract.');
      }
    });
  } finally {
    await mastra.shutdown();
  }
}

async function runProbe(
  modelId: string,
  capability: Capability,
  probe: () => Promise<void>,
): Promise<void> {
  try {
    await probe();
  } catch {
    throw new PlusOneError({
      category: 'validation_rejected',
      code: 'llm_orchestrator_capability_unsupported',
      message: 'Configured orchestrator model does not support the required runtime contract.',
      retry: 'never',
      receiptLookupRequired: false,
      details: { modelId, capability },
      cause: new Error('Orchestrator model capability probe failed.'),
    });
  }
}
