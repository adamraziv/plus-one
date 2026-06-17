import type { z } from 'zod';
import type { ContractualRoleContext } from '../context/role-context-builder.js';
import type { TeamRoleKind } from '../teams/definitions.js';

export interface StructuredAgentCall<Output> extends ContractualRoleContext {
  runId: string;
  agentId: string;
  modelId: string;
  roleKind: TeamRoleKind;
  outputSchema: z.ZodType<Output>;
  maxSteps: number;
  maxRetries: number;
  maxToolConcurrency: number;
  maxProcessorRetries: number;
  maxOutputBytes: number;
  abortSignal: AbortSignal;
}

export interface StructuredAgentPort {
  generate<Output>(call: StructuredAgentCall<Output>): Promise<Output>;
}
