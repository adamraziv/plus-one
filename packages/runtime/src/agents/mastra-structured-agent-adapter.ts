import { PlusOneError } from '@plus-one/contracts';
import type { AgentRegistry } from './agent-registry.js';
import type { StructuredAgentCall, StructuredAgentPort } from './structured-agent-port.js';

export class MastraStructuredAgentAdapter implements StructuredAgentPort {
  constructor(private readonly agents: AgentRegistry) {}

  async generate<Output>(call: StructuredAgentCall<Output>): Promise<Output> {
    if (call.parentMessages.length !== 0 || call.toolHistory.length !== 0 || call.memoryEnabled) {
      throw new PlusOneError({ category: 'policy_rejected', code: 'contractual_context_not_isolated',
        message: 'Contractual calls cannot inherit messages, memory, or tool history',
        retry: 'never', receiptLookupRequired: false, details: { roleKind: call.roleKind } });
    }
    const registration = this.agents.resolve(call.agentId, call.modelId, call.roleKind);
    if (call.roleKind === 'checker' && registration.memoryEnabled) {
      throw new PlusOneError({ category: 'policy_rejected', code: 'checker_memory_forbidden',
        message: 'Checker memory must be disabled', retry: 'never',
        receiptLookupRequired: false, details: {} });
    }
    const structuredOutput = {
      schema: call.outputSchema,
      errorStrategy: 'strict' as const,
      jsonPromptInjection: true,
    };
    const agent = registration.agent as unknown as { generate: (messages: readonly { role: string; content: string }[], options: Record<string, unknown>) => Promise<{ object?: unknown; text?: unknown }> }; const options = {
      instructions: call.systemPrompt,
      structuredOutput,
      activeTools: [...call.activeTools],
      maxSteps: call.maxSteps,
      maxRetries: call.maxRetries,
      toolCallConcurrency: call.maxToolConcurrency,
      maxProcessorRetries: call.maxProcessorRetries,
      runId: call.runId,
      abortSignal: call.abortSignal,
      telemetry: { isEnabled: false },
    };
    const fallback = async () => agent.generate([
      ...call.messages,
      { role: 'user', content: 'Return only valid JSON matching the requested output contract.' },
    ], { ...options, structuredOutput: undefined });
    const result = call.modelId.includes('/')
      ? await agent.generate([...call.messages], options).catch(fallback)
      : await fallback();
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

function parseJsonObject(text: unknown): unknown {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return undefined;
  return JSON.parse(trimmed.slice(start, end + 1));
}
