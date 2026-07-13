import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { PlusOneError } from '@plus-one/contracts';
import { assertProviderToolId } from '../tools/tool-permission-registry.js';
import type { AgentRegistry } from './agent-registry.js';
import { createTransientModelRetryProcessor } from './model-error-retry.js';
import type { StructuredAgentCall, StructuredAgentPort } from './structured-agent-port.js';

const SubmitResultToolId = 'submitResult';
const SubmissionAcknowledgementSchema = z.object({ accepted: z.literal(true) }).strict();

interface MastraGenerationResult {
  toolResults?: unknown;
  steps?: unknown;
}

export class MastraStructuredAgentAdapter implements StructuredAgentPort {
  constructor(private readonly agents: AgentRegistry) {}

  async generate<Output>(call: StructuredAgentCall<Output>): Promise<Output> {
    assertIsolatedContext(call);
    for (const toolId of call.activeTools) assertProviderToolId(toolId);

    const registration = this.agents.resolve(call.agentId, call.modelId, call.roleKind);
    if (call.roleKind === 'checker' && registration.memoryEnabled) {
      throw new PlusOneError({
        category: 'policy_rejected',
        code: 'checker_memory_forbidden',
        message: 'Checker memory must be disabled',
        retry: 'never',
        receiptLookupRequired: false,
        details: {},
      });
    }

    const hasDomainTools = call.activeTools.length !== 0;
    const requiredSteps = hasDomainTools ? 2 : 1;
    if (call.maxSteps < requiredSteps) {
      throw new PlusOneError({
        category: 'validation_rejected',
        code: 'model_step_budget_too_small',
        message: 'The runtime policy does not allow enough model steps for the contractual trajectory.',
        retry: 'never',
        receiptLookupRequired: false,
        details: {
          agentId: call.agentId,
          requiredSteps,
          maxSteps: call.maxSteps,
        },
      });
    }

    const submissions: Output[] = [];
    const submitResult = createTool({
      id: SubmitResultToolId,
      description: 'Submit the complete result for this invocation. This is the only valid completion channel.',
      inputSchema: call.outputSchema,
      outputSchema: SubmissionAcknowledgementSchema,
      execute: async (inputData) => {
        if (submissions.length !== 0) {
          throw new PlusOneError({
            category: 'validation_rejected',
            code: 'structured_result_submitted_multiple_times',
            message: 'The model submitted more than one contractual result.',
            retry: 'never',
            receiptLookupRequired: false,
            details: { agentId: call.agentId, roleKind: call.roleKind },
          });
        }
        submissions.push(call.outputSchema.parse(inputData));
        return { accepted: true as const };
      },
    });

    const errorProcessors = call.maxRetries === 0
      ? []
      : [createTransientModelRetryProcessor({ maxRetries: call.maxRetries })];
    const agent = registration.agent as unknown as {
      generate: (
        messages: readonly { role: string; content: string }[],
        options: Record<string, unknown>,
      ) => Promise<MastraGenerationResult>;
    };
    const result = await agent.generate([...call.messages], {
      instructions: contractualInstructions(call, hasDomainTools),
      activeTools: [...call.activeTools],
      maxSteps: requiredSteps,
      maxRetries: 0,
      errorProcessors,
      maxProcessorRetries: Math.max(call.maxProcessorRetries, call.maxRetries),
      toolChoice: 'auto',
      toolCallConcurrency: call.maxToolConcurrency,
      prepareStep: ({ stepNumber }: { stepNumber: number }) => {
        if (hasDomainTools && stepNumber === 0) {
          return {
            activeTools: [...call.activeTools],
            toolChoice: 'auto' as const,
          };
        }
        return {
          tools: { [SubmitResultToolId]: submitResult },
          activeTools: [SubmitResultToolId],
          toolChoice: 'auto' as const,
        };
      },
      runId: call.runId,
      abortSignal: call.abortSignal,
      telemetry: { isEnabled: false },
    });

    assertExecutedActiveTool(call, result);
    if (submissions.length === 0) {
      throw new PlusOneError({
        category: 'validation_rejected',
        code: 'structured_result_not_submitted',
        message: 'The model did not submit the required contractual result.',
        retry: 'safe',
        receiptLookupRequired: false,
        details: { agentId: call.agentId, roleKind: call.roleKind },
      });
    }
    const parsed = call.outputSchema.parse(submissions[0]);
    const outputBytes = Buffer.byteLength(JSON.stringify(parsed), 'utf8');
    if (outputBytes > call.maxOutputBytes) {
      throw new PlusOneError({
        category: 'validation_rejected',
        code: 'structured_output_too_large',
        message: 'Structured output exceeds the runtime policy limit',
        retry: 'never',
        receiptLookupRequired: false,
        details: { outputBytes, maxOutputBytes: call.maxOutputBytes },
      });
    }
    return parsed;
  }
}

function assertIsolatedContext<Output>(call: StructuredAgentCall<Output>): void {
  if (call.parentMessages.length === 0 && call.toolHistory.length === 0 && !call.memoryEnabled) return;
  throw new PlusOneError({
    category: 'policy_rejected',
    code: 'contractual_context_not_isolated',
    message: 'Contractual calls cannot inherit messages, memory, or tool history',
    retry: 'never',
    receiptLookupRequired: false,
    details: { roleKind: call.roleKind },
  });
}

function contractualInstructions<Output>(
  call: StructuredAgentCall<Output>,
  hasDomainTools: boolean,
): string {
  const completion = hasDomainTools
    ? 'First call one approved domain tool. After receiving its result, call submitResult exactly once with the complete contractual result.'
    : 'Call submitResult exactly once with the complete contractual result.';
  return [
    call.systemPrompt,
    completion,
    'Do not return the contractual result as text or JSON text.',
  ].join('\n');
}

function assertExecutedActiveTool<Output>(
  call: StructuredAgentCall<Output>,
  result: MastraGenerationResult,
): void {
  if (call.activeTools.length === 0) return;
  const activeTools = new Set(call.activeTools);
  if (collectToolResultNames(result).some((toolName) => activeTools.has(toolName))) return;
  throw new PlusOneError({
    category: 'runtime_failure',
    code: 'tool_call_not_executed',
    message: 'Tool-enabled agent returned without executing an active tool',
    retry: 'safe',
    receiptLookupRequired: false,
    details: {
      agentId: call.agentId,
      roleKind: call.roleKind,
      activeTools: call.activeTools.join(','),
    },
  });
}

function collectToolResultNames(result: MastraGenerationResult): string[] {
  const chunks: unknown[] = [];
  if (Array.isArray(result.toolResults)) chunks.push(...result.toolResults);
  if (Array.isArray(result.steps)) {
    for (const step of result.steps) {
      if (step !== null && typeof step === 'object') {
        const toolResults = (step as { toolResults?: unknown }).toolResults;
        if (Array.isArray(toolResults)) chunks.push(...toolResults);
      }
    }
  }
  return chunks.flatMap((chunk) => {
    if (chunk === null || typeof chunk !== 'object') return [];
    const direct = (chunk as { toolName?: unknown }).toolName;
    if (typeof direct === 'string') return [direct];
    const payload = (chunk as { payload?: unknown }).payload;
    if (payload !== null && typeof payload === 'object') {
      const toolName = (payload as { toolName?: unknown }).toolName;
      if (typeof toolName === 'string') return [toolName];
    }
    return [];
  });
}
