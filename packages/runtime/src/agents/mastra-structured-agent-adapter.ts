import { PlusOneError } from '@plus-one/contracts';
import { assertProviderToolId } from '../tools/tool-permission-registry.js';
import type { AgentRegistry } from './agent-registry.js';
import { createTransientModelRetryProcessor } from './model-error-retry.js';
import type { StructuredAgentCall, StructuredAgentPort } from './structured-agent-port.js';

interface MastraGenerationResult {
  object?: unknown;
  text?: unknown;
  toolResults?: unknown;
  steps?: unknown;
}

export class MastraStructuredAgentAdapter implements StructuredAgentPort {
  constructor(private readonly agents: AgentRegistry) {}

  async generate<Output>(call: StructuredAgentCall<Output>): Promise<Output> {
    if (call.parentMessages.length !== 0 || call.toolHistory.length !== 0 || call.memoryEnabled) {
      throw new PlusOneError({ category: 'policy_rejected', code: 'contractual_context_not_isolated',
        message: 'Contractual calls cannot inherit messages, memory, or tool history',
        retry: 'never', receiptLookupRequired: false, details: { roleKind: call.roleKind } });
    }
    for (const toolId of call.activeTools) {
      assertProviderToolId(toolId);
    }
    const registration = this.agents.resolve(call.agentId, call.modelId, call.roleKind);
    if (call.roleKind === 'checker' && registration.memoryEnabled) {
      throw new PlusOneError({ category: 'policy_rejected', code: 'checker_memory_forbidden',
        message: 'Checker memory must be disabled', retry: 'never',
        receiptLookupRequired: false, details: {} });
    }
    const structuredOutputModel = call.activeTools.length === 0
      ? undefined
      : mastraModelConfigFromAgent(registration.agent);
    const structuredOutput = {
      schema: call.outputSchema,
      errorStrategy: 'strict' as const,
      jsonPromptInjection: true,
      ...(structuredOutputModel === undefined ? {} : { model: structuredOutputModel }),
    };
    const agent = registration.agent as unknown as {
      generate: (
        messages: readonly { role: string; content: string }[],
        options: Record<string, unknown>,
      ) => Promise<MastraGenerationResult>;
    };
    const errorProcessors = call.maxRetries === 0
      ? []
      : [createTransientModelRetryProcessor({ maxRetries: call.maxRetries })];
    const options = {
      instructions: call.systemPrompt,
      structuredOutput,
      activeTools: [...call.activeTools],
      maxSteps: call.maxSteps,
      maxRetries: 0,
      toolCallConcurrency: call.maxToolConcurrency,
      errorProcessors,
      maxProcessorRetries: Math.max(call.maxProcessorRetries, call.maxRetries),
      runId: call.runId,
      abortSignal: call.abortSignal,
      telemetry: { isEnabled: false },
    };
    const fallback = async () => agent.generate([
      ...call.messages,
      { role: 'user', content: 'Return only valid JSON matching the requested output contract.' },
    ], { ...options, structuredOutput: undefined });
    const result = call.modelId.includes('/')
      ? await agent.generate([...call.messages], options).catch((error) => {
        if (call.activeTools.length !== 0) throw error;
        return fallback();
      })
      : await fallback();
    assertExecutedActiveTool(call, result);
    const parsed = call.outputSchema.parse(result.object ?? parseJsonObject(result.text));
    const outputBytes = Buffer.byteLength(JSON.stringify(parsed), 'utf8');
    if (outputBytes > call.maxOutputBytes) {
      throw new PlusOneError({ category: 'validation_rejected', code: 'structured_output_too_large',
        message: 'Structured output exceeds the runtime policy limit', retry: 'never',
        receiptLookupRequired: false, details: { outputBytes, maxOutputBytes: call.maxOutputBytes } });
    }
    return parsed;
  }
}

function mastraModelConfigFromAgent(agent: unknown): {
  id: string;
  url?: string;
  apiKey?: string;
  headers?: Record<string, string>;
} | undefined {
  if (agent === null || typeof agent !== 'object') return undefined;
  const model = (agent as { model?: unknown }).model;
  if (model === null || typeof model !== 'object' || Array.isArray(model)) return undefined;
  if (typeof (model as { id?: unknown }).id !== 'string') return undefined;
  return model as {
    id: string;
    url?: string;
    apiKey?: string;
    headers?: Record<string, string>;
  };
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

function parseJsonObject(text: unknown): unknown {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return undefined;
  return JSON.parse(trimmed.slice(start, end + 1));
}
