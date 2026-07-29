import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { PlusOneError } from '@plus-one/contracts';
import { assertProviderToolId } from '../tools/tool-permission-registry.js';
import type { AgentRegistry } from './agent-registry.js';
import {
  createTransientModelRetryProcessor,
  modelResultEndedOnRetry,
  ModelTemporarilyUnavailableError,
  stopAfterSemanticModelSteps,
} from './model-error-retry.js';
import type { StructuredAgentCall, StructuredAgentPort } from './structured-agent-port.js';

const SubmitResultToolId = 'submitResult';
const SubmissionAcknowledgementSchema = z.object({ accepted: z.literal(true) }).strict();

interface MastraGenerationResult {
  finishReason?: unknown;
  text?: unknown;
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
    const providerSubmissionSchema = z.preprocess(
      (value) => normalizeProviderSubmission(value, call.roleKind),
      call.outputSchema,
    );
    const submitResult = createTool({
      id: SubmitResultToolId,
      description: 'Submit the complete result for this invocation. This is the only valid completion channel.',
      inputSchema: providerSubmissionSchema,
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

    let lastProviderError: unknown;
    const errorProcessors = call.maxRetries === 0
      ? []
      : [createTransientModelRetryProcessor({
          maxRetries: call.maxRetries,
          onError: (error) => {
            lastProviderError = error;
          },
        })];
    const agent = registration.agent as unknown as {
      generate: (
        messages: readonly { role: string; content: string }[],
        options: Record<string, unknown>,
      ) => Promise<MastraGenerationResult>;
    };
    const canRepairWithoutToolState = !hasDomainTools && call.maxSteps > 1;
    const repairStepLimit = canRepairWithoutToolState ? call.maxSteps - 1 : 0;
    const initialStepLimit = call.maxSteps - repairStepLimit;
    const stopAtStepLimit = stopAfterSemanticModelSteps(initialStepLimit);
    const result = await agent.generate([...call.messages], {
      instructions: contractualInstructions(call, hasDomainTools),
      activeTools: [...call.activeTools],
      stopWhen: ({ steps }: { steps: readonly unknown[] }) =>
        submissions.length !== 0 || stopAtStepLimit({ steps }),
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

    if (modelResultEndedOnRetry(result)) {
      throw new ModelTemporarilyUnavailableError(lastProviderError);
    }
    assertExecutedActiveTool(call, result);
    const textSubmission = parseTextSubmission(result, call.outputSchema, call.roleKind);
    let parsed: Output;
    if (submissions.length !== 0) {
      parsed = call.outputSchema.parse(submissions[0]);
    } else if (textSubmission !== undefined) {
      parsed = textSubmission;
    } else if (canRepairWithoutToolState) {
      const stopAtRepairLimit = stopAfterSemanticModelSteps(repairStepLimit);
      const repairResult = await agent.generate([...call.messages], {
        instructions: contractualRepairInstructions(call),
        activeTools: [SubmitResultToolId],
        stopWhen: ({ steps }: { steps: readonly unknown[] }) =>
          submissions.length !== 0 || stopAtRepairLimit({ steps }),
        maxRetries: 0,
        errorProcessors,
        maxProcessorRetries: Math.max(call.maxProcessorRetries, call.maxRetries),
        toolChoice: 'auto',
        toolCallConcurrency: call.maxToolConcurrency,
        prepareStep: () => ({
          tools: { [SubmitResultToolId]: submitResult },
          activeTools: [SubmitResultToolId],
          toolChoice: 'auto' as const,
        }),
        runId: `${call.runId}:contract-repair`,
        abortSignal: call.abortSignal,
        telemetry: { isEnabled: false },
      });
      if (modelResultEndedOnRetry(repairResult)) {
        throw new ModelTemporarilyUnavailableError(lastProviderError);
      }
      const repairedTextSubmission = parseTextSubmission(
        repairResult,
        call.outputSchema,
        call.roleKind,
      );
      if (submissions.length === 0 && repairedTextSubmission === undefined) {
        throw structuredResultNotSubmitted(call);
      }
      parsed = submissions.length === 0
        ? repairedTextSubmission!
        : call.outputSchema.parse(submissions[0]);
    } else {
      throw structuredResultNotSubmitted(call);
    }
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
    contractualOutputHint(call),
    completion,
    'Prefer submitResult. If you do not call it, return only one raw JSON object matching the same contract; do not wrap it in prose.',
  ].join('\n');
}

function contractualRepairInstructions<Output>(call: StructuredAgentCall<Output>): string {
  return [
    call.systemPrompt,
    contractualOutputHint(call),
    'Execution state: the previous contractual attempt ended without a valid structured submission.',
    'Complete the same task now by calling submitResult exactly once with the full contractual result.',
    'If you do not call submitResult, return only one raw JSON object matching the same contract; do not wrap it in prose.',
  ].join('\n');
}

function contractualOutputHint<Output>(call: StructuredAgentCall<Output>): string {
  if (call.roleKind === 'checker') {
    return 'Contract: {"verdict":"accepted|rejected|revision_requested|insufficient_evidence|conflicted","findings":[{"code":"non-empty","message":"non-empty"}]}.';
  }
  if (call.roleKind === 'lead') {
    return 'Contract: {"schemaName":"team-lead-plan","schemaVersion":1,"recommendedStrategyName":"allowed-strategy","work":[{"workCellId":"allowed-work-cell"}],"stopCondition":{"code":"kebab-case","description":"non-empty"}}. Do not include makerInput.';
  }
  return 'Contract: use every required field in the submitResult input schema exactly; do not add an outer wrapper.';
}

function parseTextSubmission<Output>(
  result: MastraGenerationResult,
  schema: z.ZodType<Output>,
  roleKind: StructuredAgentCall<unknown>['roleKind'],
): Output | undefined {
  for (const text of collectResultTexts(result)) {
    const candidate = rawJsonCandidate(text);
    if (candidate === undefined) continue;
    try {
      const parsed = schema.safeParse(normalizeProviderSubmission(JSON.parse(candidate), roleKind));
      if (parsed.success) return parsed.data;
    } catch {
      continue;
    }
  }
  return undefined;
}

function normalizeProviderSubmission(
  value: unknown,
  roleKind: StructuredAgentCall<unknown>['roleKind'],
): unknown {
  if (roleKind !== 'maker' || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const output = (value as { output?: unknown }).output;
  if (typeof output !== 'string') return value;
  const parsed = parseJsonObject(output);
  return parsed === undefined ? value : { ...value, output: parsed };
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function collectResultTexts(result: MastraGenerationResult): string[] {
  const texts: string[] = typeof result.text === 'string' ? [result.text] : [];
  if (!Array.isArray(result.steps)) return texts;
  for (const step of result.steps) {
    if (step !== null && typeof step === 'object') {
      const text = (step as { text?: unknown }).text;
      if (typeof text === 'string') texts.push(text);
    }
  }
  return texts;
}

function rawJsonCandidate(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1]?.trim();
}

function structuredResultNotSubmitted<Output>(call: StructuredAgentCall<Output>): PlusOneError {
  return new PlusOneError({
    category: 'validation_rejected',
    code: 'structured_result_not_submitted',
    message: 'The model did not submit the required contractual result.',
    retry: 'safe',
    receiptLookupRequired: false,
    details: { agentId: call.agentId, roleKind: call.roleKind },
  });
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
